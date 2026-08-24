import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { codedHistoryBaseKey, nextOccurrence, parseAccountingMoney } from "@/lib/accounting-import-utils";
import { ensureSchema, getSql } from "@/lib/db";
import { ValidationError } from "@/lib/http";
import { ensureIntegrationSchema } from "@/lib/integrations";
import { assertBalancedJournalLines } from "@/lib/journal-integrity";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowValue(row: Record<string, unknown>, names: string[]): unknown {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  for (const name of names) {
    const value = normalized.get(normalizeKey(name));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = clean(value, 80);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export async function ensureAccountingControlSchema(): Promise<void> {
  await ensureSchema();
  await ensureIntegrationSchema();
  const sql = getSql();







}

async function accountId(business: Business, code: string): Promise<string> {
  const rows = await getSql()`
    SELECT id FROM accounting_accounts
    WHERE business = ${business} AND code = ${clean(code, 20)} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error(`Accounting account ${code} was not found for ${business}.`);
  return rows[0].id;
}

async function loadBankTransaction(id: string, business?: Business) {
  const rows = business
    ? await getSql()`
        SELECT id, business, external_transaction_id, external_account_id, transaction_date,
          merchant_name, description, signed_amount, direction, pending, removed,
          category, account_code, review_status
        FROM bank_transactions WHERE id = ${id} AND business = ${business} LIMIT 1
      `
    : await getSql()`
        SELECT id, business, external_transaction_id, external_account_id, transaction_date,
          merchant_name, description, signed_amount, direction, pending, removed,
          category, account_code, review_status
        FROM bank_transactions WHERE id = ${id} LIMIT 1
      `;
  const transaction = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!transaction) throw new Error("Bank transaction was not found.");
  return transaction;
}

export async function saveTransactionSplits(input: {
  transactionId: string;
  business: Business;
  lines: Array<{ accountCode: string; amount: number; memo?: string }>;
  actor: string;
}) {
  await ensureAccountingControlSchema();
  const transaction = await loadBankTransaction(input.transactionId, input.business);
  const posted = await getSql()`
    SELECT id FROM bank_transaction_postings WHERE bank_transaction_id = ${input.transactionId} LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (posted[0]) throw new Error("Posted bank transactions cannot be re-split. Reverse the journal entry first.");
  if (!input.lines.length) throw new Error("Add at least one split line.");

  const lines = input.lines.map((line) => ({
    accountCode: clean(line.accountCode, 20),
    amount: roundMoney(Math.abs(Number(line.amount || 0))),
    memo: clean(line.memo, 300),
  }));
  if (lines.some((line) => !line.accountCode || line.amount <= 0)) throw new Error("Each split needs an account and a positive amount.");
  const expected = roundMoney(Math.abs(numberValue(transaction.signed_amount)));
  const supplied = roundMoney(lines.reduce((sum, line) => sum + line.amount, 0));
  if (Math.abs(expected - supplied) > 0.005) {
    throw new Error(`Split total must equal ${expected.toFixed(2)}; supplied ${supplied.toFixed(2)}.`);
  }
  for (const line of lines) await accountId(input.business, line.accountCode);

  await getSql()`DELETE FROM bank_transaction_splits WHERE bank_transaction_id = ${input.transactionId}`;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await getSql()`
      INSERT INTO bank_transaction_splits (
        id, bank_transaction_id, line_number, account_code, amount, memo, created_by
      ) VALUES (
        ${crypto.randomUUID()}, ${input.transactionId}, ${index + 1}, ${line.accountCode},
        ${line.amount}, ${line.memo}, ${input.actor}
      )
    `;
  }
  await getSql()`
    UPDATE bank_transactions SET review_status = 'Approved', user_override = TRUE,
      classification_source = 'Owner split', confidence = 1, updated_at = NOW()
    WHERE id = ${input.transactionId}
  `;
  return { saved: true, total: supplied, lines: lines.length };
}

export async function postBankTransaction(input: { transactionId: string; business: Business; actor: string }) {
  await ensureAccountingControlSchema();
  const transaction = await loadBankTransaction(input.transactionId, input.business);
  if (transaction.pending) throw new ValidationError("Pending transactions cannot be posted.");
  if (transaction.removed) throw new ValidationError("Removed transactions cannot be posted.");
  if (transaction.review_status !== "Approved") throw new ValidationError("Approve the transaction before posting it.");
  const sql = getSql();
  const existing = await sql`SELECT journal_entry_id FROM bank_transaction_postings WHERE bank_transaction_id = ${input.transactionId} LIMIT 1` as unknown as Array<{ journal_entry_id: string }>;
  if (existing[0]) return { posted: false, journalEntryId: existing[0].journal_entry_id, duplicate: true };
  const splitRows = await sql`SELECT account_code, amount, memo FROM bank_transaction_splits WHERE bank_transaction_id = ${input.transactionId} ORDER BY line_number` as unknown as Array<{ account_code: string; amount: string | number; memo: string }>;
  const amount = roundMoney(Math.abs(numberValue(transaction.signed_amount)));
  const categoryLines = splitRows.length ? splitRows.map((row) => ({ code: row.account_code, amount: roundMoney(numberValue(row.amount)) })) : [{ code: clean(transaction.account_code, 20), amount }];
  if (!categoryLines[0].code) throw new ValidationError("Choose an accounting account before posting.");
  if (Math.abs(categoryLines.reduce((sum, line) => sum + line.amount, 0) - amount) > 0.005) throw new ValidationError("Transaction splits no longer equal the bank amount.");
  const cashId = await accountId(input.business, "1000");
  const categoryIds = new Map<string,string>();
  for (const line of categoryLines) categoryIds.set(line.code, await accountId(input.business, line.code));
  const positive = numberValue(transaction.signed_amount) > 0;
  const journalLines = positive
    ? [{ accountId: cashId, debit: amount, credit: 0 }, ...categoryLines.map((line) => ({ accountId: categoryIds.get(line.code)!, debit: 0, credit: line.amount }))]
    : [...categoryLines.map((line) => ({ accountId: categoryIds.get(line.code)!, debit: line.amount, credit: 0 })), { accountId: cashId, debit: 0, credit: amount }];
  assertBalancedJournalLines(journalLines);
  const entryId = crypto.randomUUID();
  const description = clean(transaction.merchant_name || transaction.description, 240) || "Bank transaction";
  await sql.transaction([
    sql`INSERT INTO journal_entries (id,business,entry_date,description,source,reference,created_by) VALUES (${entryId},${input.business},${String(transaction.transaction_date)},${description},'Bank Import',${`bank:${transaction.external_transaction_id}`},${input.actor})`,
    ...journalLines.map((line) => sql`INSERT INTO journal_lines (id,entry_id,account_id,debit,credit) VALUES (${crypto.randomUUID()},${entryId},${line.accountId},${line.debit},${line.credit})`),
    sql`INSERT INTO bank_transaction_postings (id,bank_transaction_id,journal_entry_id,posted_by) VALUES (${crypto.randomUUID()},${input.transactionId},${entryId},${input.actor})`,
  ]);
  return { posted: true, journalEntryId: entryId };
}

export async function postAllApprovedBankTransactions(input: { business: Business; actor: string }) {
  await ensureAccountingControlSchema();
  const rows = await getSql()`
    SELECT t.id
    FROM bank_transactions t
    LEFT JOIN bank_transaction_postings p ON p.bank_transaction_id = t.id
    WHERE t.business = ${input.business} AND t.review_status = 'Approved'
      AND t.pending = FALSE AND t.removed = FALSE AND p.id IS NULL
    ORDER BY t.transaction_date, t.created_at
  ` as unknown as Array<{ id: string }>;
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const row of rows) {
    try {
      await postBankTransaction({ transactionId: row.id, business: input.business, actor: input.actor });
      results.push({ id: row.id, ok: true });
    } catch (error) {
      results.push({ id: row.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { attempted: rows.length, posted: results.filter((result) => result.ok).length, results };
}

export async function createOpeningBalance(input: {
  business: Business;
  entryDate: string;
  description: string;
  reference?: string;
  lines: Array<{ accountCode: string; debit?: number; credit?: number }>;
  actor: string;
}) {
  await ensureAccountingControlSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate)) throw new Error("Choose a valid opening-balance date.");
  const lines = input.lines.map((line) => ({
    code: clean(line.accountCode, 20),
    debit: roundMoney(Math.max(0, Number(line.debit || 0))),
    credit: roundMoney(Math.max(0, Number(line.credit || 0))),
  })).filter((line) => line.debit || line.credit);
  if (lines.length < 2) throw new Error("Opening balances need at least two lines.");
  if (lines.some((line) => !line.code || (line.debit > 0 && line.credit > 0))) throw new Error("Each opening balance line needs one debit or one credit.");
  const debits = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
  const credits = roundMoney(lines.reduce((sum, line) => sum + line.credit, 0));
  if (Math.abs(debits - credits) > 0.005) throw new Error(`Opening balances are out of balance by ${Math.abs(debits - credits).toFixed(2)}.`);
  const ids = new Map<string, string>();
  for (const line of lines) ids.set(line.code, await accountId(input.business, line.code));
  const entryId = crypto.randomUUID();
  await getSql()`
    INSERT INTO journal_entries (id, business, entry_date, description, source, reference, created_by)
    VALUES (
      ${entryId}, ${input.business}, ${input.entryDate}, ${clean(input.description, 240) || 'Opening balances'},
      'Opening Balance', ${clean(input.reference, 100)}, ${input.actor}
    )
  `;
  for (const line of lines) {
    await getSql()`
      INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
      VALUES (${crypto.randomUUID()}, ${entryId}, ${ids.get(line.code)!}, ${line.debit}, ${line.credit})
    `;
  }
  return { id: entryId, debits, credits };
}

export async function saveBankReconciliation(input: {
  id?: string;
  business: Business;
  externalAccountId: string;
  statementStartDate: string;
  statementEndDate: string;
  beginningBalance: number;
  endingBalance: number;
  transactionIds: string[];
  notes?: string;
  finalize?: boolean;
  actor: string;
}) {
  await ensureAccountingControlSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.statementStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.statementEndDate)) {
    throw new Error("Statement start and end dates are required.");
  }
  if (input.statementEndDate < input.statementStartDate) throw new Error("Statement end date cannot precede the start date.");
  const selected = [...new Set(input.transactionIds.filter(Boolean))];
  let clearedActivity = 0;
  for (const transactionId of selected) {
    const rows = await getSql()`
      SELECT signed_amount FROM bank_transactions
      WHERE id = ${transactionId} AND business = ${input.business}
        AND external_account_id = ${clean(input.externalAccountId, 180)}
      LIMIT 1
    ` as unknown as Array<{ signed_amount: string | number }>;
    if (!rows[0]) throw new Error("One or more selected transactions do not belong to this bank account.");
    clearedActivity += numberValue(rows[0].signed_amount);
  }
  clearedActivity = roundMoney(clearedActivity);
  const expectedActivity = roundMoney(Number(input.endingBalance || 0) - Number(input.beginningBalance || 0));
  const difference = roundMoney(expectedActivity - clearedActivity);
  if (input.finalize && Math.abs(difference) > 0.005) throw new Error(`Reconciliation is out of balance by ${difference.toFixed(2)}.`);

  const id = input.id || crypto.randomUUID();
  if (input.id) {
    const current = await getSql()`SELECT status FROM bank_reconciliations WHERE id = ${id} AND business = ${input.business} LIMIT 1` as unknown as Array<{ status: string }>;
    if (!current[0]) throw new Error("Reconciliation was not found.");
    if (current[0].status === "Finalized") throw new Error("Finalized reconciliations are locked. Reopen it first.");
    await getSql()`
      UPDATE bank_reconciliations SET
        external_account_id = ${clean(input.externalAccountId, 180)},
        statement_start_date = ${input.statementStartDate}, statement_end_date = ${input.statementEndDate},
        statement_beginning_balance = ${roundMoney(Number(input.beginningBalance || 0))},
        statement_ending_balance = ${roundMoney(Number(input.endingBalance || 0))},
        cleared_activity = ${clearedActivity}, difference = ${difference}, notes = ${clean(input.notes, 1000)},
        status = ${input.finalize ? 'Finalized' : 'Draft'},
        finalized_by = ${input.finalize ? input.actor : null},
        finalized_at = ${input.finalize ? new Date().toISOString() : null}, updated_at = NOW()
      WHERE id = ${id} AND business = ${input.business}
    `;
    await getSql()`DELETE FROM bank_reconciliation_items WHERE reconciliation_id = ${id} AND EXISTS (SELECT 1 FROM bank_reconciliations WHERE id = ${id} AND business = ${input.business})`;
  } else {
    await getSql()`
      INSERT INTO bank_reconciliations (
        id, business, external_account_id, statement_start_date, statement_end_date,
        statement_beginning_balance, statement_ending_balance, cleared_activity, difference,
        status, notes, created_by, finalized_by, finalized_at
      ) VALUES (
        ${id}, ${input.business}, ${clean(input.externalAccountId, 180)}, ${input.statementStartDate}, ${input.statementEndDate},
        ${roundMoney(Number(input.beginningBalance || 0))}, ${roundMoney(Number(input.endingBalance || 0))},
        ${clearedActivity}, ${difference}, ${input.finalize ? 'Finalized' : 'Draft'}, ${clean(input.notes, 1000)},
        ${input.actor}, ${input.finalize ? input.actor : null}, ${input.finalize ? new Date().toISOString() : null}
      )
    `;
  }
  for (const transactionId of selected) {
    await getSql()`
      INSERT INTO bank_reconciliation_items (reconciliation_id, bank_transaction_id)
      VALUES (${id}, ${transactionId})
    `;
  }
  return { id, clearedActivity, expectedActivity, difference, status: input.finalize ? "Finalized" : "Draft" };
}

export async function reopenBankReconciliation(id: string, business: Business, actor: string) {
  await ensureAccountingControlSchema();
  const rows = await getSql()`
    UPDATE bank_reconciliations SET status = 'Reopened', finalized_by = NULL, finalized_at = NULL,
      notes = CONCAT(notes, CASE WHEN notes = '' THEN '' ELSE E'\n' END, ${`Reopened by ${actor} on ${new Date().toISOString()}`}), updated_at = NOW()
    WHERE id = ${id} AND business = ${business} AND status = 'Finalized'
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new ValidationError("Only finalized reconciliations in this business can be reopened.");
  return { reopened: true };
}

export async function importCodedHistory(input: {
  business: Business; institutionName: string; accountType: "depository" | "credit";
  fileName: string; bytes: ArrayBuffer; postApproved: boolean; actor: string;
}) {
  await ensureAccountingControlSchema();
  const workbook = XLSX.read(Buffer.from(input.bytes), { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new ValidationError("The historical workbook did not contain a readable worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false, dateNF: "yyyy-mm-dd" });
  const externalItemId = `history:${createHash("sha256").update(`${input.business}|${input.institutionName}|${input.accountType}`).digest("hex").slice(0,24)}`;
  const connectionRows = await getSql()`INSERT INTO integration_connections (id,provider,business,institution_name,external_item_id,metadata) VALUES (${crypto.randomUUID()},'CSV',${input.business},${clean(input.institutionName,120)},${externalItemId},${JSON.stringify({source:'Coded historical workbook',fileName:input.fileName,actor:input.actor,accountType:input.accountType})}::jsonb) ON CONFLICT (provider,external_item_id) DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=NOW() RETURNING id` as unknown as Array<{id:string}>;
  const connectionId = connectionRows[0].id;
  await getSql()`INSERT INTO bank_accounts (id,connection_id,business,external_account_id,institution_name,name,official_name,account_type,account_subtype,currency,active) VALUES (${crypto.randomUUID()},${connectionId},${input.business},${externalItemId},${clean(input.institutionName,120)},${clean(input.institutionName,120)},${clean(input.institutionName,120)},${input.accountType},${input.accountType === 'credit' ? 'credit card' : 'checking'},'USD',TRUE) ON CONFLICT (external_account_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,institution_name=EXCLUDED.institution_name,name=EXCLUDED.name,official_name=EXCLUDED.official_name,account_type=EXCLUDED.account_type,account_subtype=EXCLUDED.account_subtype,updated_at=NOW()`;
  const accounts = await getSql()`SELECT code,name FROM accounting_accounts WHERE business=${input.business} AND active=TRUE` as unknown as Array<{code:string;name:string}>;
  const byName = new Map(accounts.map((a)=>[normalizeKey(a.name),a.code])); const validCodes=new Set(accounts.map((a)=>a.code));
  const occurrence=new Map<string,number>(); const insertedIds:string[]=[]; let skipped=0; let badAmounts=0;
  for (const row of rows) {
    const date=dateValue(rowValue(row,["Date","Transaction Date","Posted Date"]));
    const merchant=clean(rowValue(row,["Merchant","Payee","Vendor","Name"]),240);
    const description=clean(rowValue(row,["Description","Memo","Details","Transaction"]),400)||merchant;
    const debit=Math.abs(parseAccountingMoney(rowValue(row,["Debit","Withdrawal","Outflow"]))); const credit=Math.abs(parseAccountingMoney(rowValue(row,["Credit","Deposit","Inflow"]))); const rawAmount=parseAccountingMoney(rowValue(row,["Signed Amount","Amount","Transaction Amount"]));
    const signedAmount=roundMoney(credit ? credit : debit ? -debit : rawAmount); if (!signedAmount) badAmounts += 1;
    const suppliedCode=clean(rowValue(row,["GL Account","Account Code","GL Code","Category Code"]),20); const suppliedCategory=clean(rowValue(row,["Category","Account Name","GL Account Name"]),160); const accountCode=validCodes.has(suppliedCode)?suppliedCode:byName.get(normalizeKey(suppliedCategory))||"";
    if(!date||!description||!signedAmount||!accountCode){skipped+=1;continue;}
    const existing = await getSql()`SELECT id,merchant_name,description FROM bank_transactions WHERE business=${input.business} AND connection_id<>${connectionId} AND transaction_date=${date} AND signed_amount=${signedAmount} AND removed=FALSE LIMIT 20` as unknown as Array<{id:string;merchant_name:string;description:string}>;
    const target=normalizeKey(merchant||description); if(target.length>=10 && existing.some((x)=>normalizeKey(x.merchant_name||x.description)===target)){skipped+=1;continue;}
    const base=codedHistoryBaseKey({externalItemId,date,description,signedAmount,accountCode}); const ordinal=nextOccurrence(occurrence,base); const externalTransactionId=createHash("sha256").update(`${base}|${ordinal}`).digest("hex"); const id=crypto.randomUUID();
    const result=await getSql()`INSERT INTO bank_transactions (id,connection_id,business,external_transaction_id,external_account_id,transaction_date,merchant_name,description,signed_amount,direction,pending,removed,category,account_code,classification_source,confidence,review_status,user_override,raw) VALUES (${id},${connectionId},${input.business},${externalTransactionId},${externalItemId},${date},${merchant},${description},${signedAmount},${signedAmount>=0?'Inflow':'Outflow'},FALSE,FALSE,${suppliedCategory||accountCode},${accountCode},'Historical coded workbook',1,'Approved',TRUE,${JSON.stringify(row)}::jsonb) ON CONFLICT (external_transaction_id) DO NOTHING RETURNING id` as unknown as Array<{id:string}>;
    if(result[0]) insertedIds.push(result[0].id);
  }
  if(rows.length>=10 && badAmounts/rows.length>0.25) throw new ValidationError(`Too many rows had unreadable amounts (${badAmounts} of ${rows.length}). No automatic posting was attempted.`);
  let posted=0; if(input.postApproved){for(const id of insertedIds){await postBankTransaction({transactionId:id,business:input.business,actor:input.actor});posted+=1;}}
  return {rowsRead:rows.length,imported:insertedIds.length,skipped,posted};
}

function squareFee(raw: unknown): number {
  const processing = (raw as Record<string, unknown> | null)?.processing_fee;
  if (!Array.isArray(processing)) return 0;
  return roundMoney(processing.reduce((sum, item) => {
    const amount = ((item as Record<string, unknown>).amount_money as Record<string, unknown> | undefined)?.amount;
    return sum + numberValue(amount) / 100;
  }, 0));
}

export async function buildSquareDepositSuggestions(actor: string) {
  await ensureAccountingControlSchema();
  const bankRows = await getSql()`
    SELECT t.id, t.transaction_date, t.signed_amount, t.merchant_name, t.description
    FROM bank_transactions t
    LEFT JOIN square_deposit_matches m ON m.bank_transaction_id = t.id
    WHERE t.business = 'Tiki' AND t.signed_amount > 0 AND t.removed = FALSE AND t.pending = FALSE
      AND m.id IS NULL
      AND (
        UPPER(t.merchant_name) LIKE '%SQUARE%' OR UPPER(t.description) LIKE '%SQUARE%'
        OR t.account_code IN ('4100', '1100')
      )
    ORDER BY t.transaction_date
  ` as unknown as Array<{ id: string; transaction_date: string; signed_amount: string | number; merchant_name: string; description: string }>;
  const paymentRows = await getSql()`
    SELECT p.id, p.created_at_square, p.amount, p.tip_amount, p.raw
    FROM square_payments p
    LEFT JOIN square_deposit_match_payments mp ON mp.square_payment_id = p.id
    WHERE p.status = 'COMPLETED' AND mp.square_payment_id IS NULL
      AND p.created_at_square >= NOW() - INTERVAL '120 days'
    ORDER BY p.created_at_square
  ` as unknown as Array<{ id: string; created_at_square: string; amount: string | number; tip_amount: string | number; raw: unknown }>;

  let suggestions = 0;
  for (const bank of bankRows) {
    const bankDate = new Date(`${bank.transaction_date}T23:59:59Z`);
    const earliest = new Date(bankDate.getTime() - 4 * 24 * 60 * 60 * 1000);
    const candidates = paymentRows.filter((payment) => {
      const date = new Date(payment.created_at_square);
      return date >= earliest && date <= bankDate;
    });
    if (!candidates.length) continue;
    const gross = roundMoney(candidates.reduce((sum, payment) => sum + numberValue(payment.amount) + numberValue(payment.tip_amount), 0));
    const fees = roundMoney(candidates.reduce((sum, payment) => sum + squareFee(payment.raw), 0));
    const net = roundMoney(gross - fees);
    const bankAmount = roundMoney(numberValue(bank.signed_amount));
    const variance = roundMoney(bankAmount - net);
    const tolerance = Math.max(5, Math.abs(bankAmount) * 0.03);
    if (Math.abs(variance) > tolerance) continue;
    const matchId = crypto.randomUUID();
    await getSql()`
      INSERT INTO square_deposit_matches (
        id, bank_transaction_id, square_gross, square_fees, square_net,
        bank_amount, variance, status, matched_by
      ) VALUES (
        ${matchId}, ${bank.id}, ${gross}, ${fees}, ${net}, ${bankAmount}, ${variance}, 'Suggested', ${actor}
      )
    `;
    for (const payment of candidates) {
      await getSql()`
        INSERT INTO square_deposit_match_payments (match_id, square_payment_id)
        VALUES (${matchId}, ${payment.id}) ON CONFLICT (square_payment_id) DO NOTHING
      `;
    }
    suggestions += 1;
  }
  return { suggestions };
}

export async function setSquareDepositMatchStatus(input: { id: string; status: "Matched" | "Ignored"; actor: string }) {
  await ensureAccountingControlSchema();
  const rows = await getSql()`
    UPDATE square_deposit_matches SET status = ${input.status}, matched_by = ${input.actor},
      matched_at = ${input.status === 'Matched' ? new Date().toISOString() : null}, updated_at = NOW()
    WHERE id = ${input.id}
    RETURNING bank_transaction_id
  ` as unknown as Array<{ bank_transaction_id: string }>;
  if (!rows[0]) throw new Error("Square deposit match was not found.");
  if (input.status === "Ignored") {
    await getSql()`DELETE FROM square_deposit_match_payments WHERE match_id = ${input.id}`;
  } else {
    await getSql()`
      UPDATE bank_transactions SET category = 'Square clearing deposit', account_code = '1100',
        classification_source = 'Square deposit match', confidence = 1,
        review_status = 'Approved', user_override = TRUE, updated_at = NOW()
      WHERE id = ${rows[0].bank_transaction_id}
    `;
  }
  return { updated: true, bankTransactionId: rows[0].bank_transaction_id };
}

export async function postSquareDay(input: { businessDate: string; actor: string }) {
  await ensureAccountingControlSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) throw new ValidationError("Choose a valid Square business date.");
  const sql=getSql(); const reference=`square:${input.businessDate}`;
  const existing=await sql`SELECT id FROM journal_entries WHERE business='Tiki' AND source='Square' AND reference=${reference} LIMIT 1` as unknown as Array<{id:string}>; if(existing[0]) return {posted:false,duplicate:true,journalEntryId:existing[0].id};
  const payments=await sql`SELECT amount,tip_amount,raw FROM square_payments WHERE status='COMPLETED' AND (created_at_square AT TIME ZONE 'America/New_York')::DATE=${input.businessDate}` as unknown as Array<{amount:string|number;tip_amount:string|number;raw:unknown}>; if(!payments.length) throw new ValidationError("No completed Square payments were found for that date.");
  const taxRows=await sql`SELECT COALESCE(SUM(tax_total),0) AS tax_total FROM square_orders WHERE state='COMPLETED' AND (COALESCE(closed_at_square,created_at_square) AT TIME ZONE 'America/New_York')::DATE=${input.businessDate}` as unknown as Array<{tax_total:string|number}>;
  const amount=roundMoney(payments.reduce((s,p)=>s+numberValue(p.amount),0)); const tips=roundMoney(payments.reduce((s,p)=>s+numberValue(p.tip_amount),0)); const fees=roundMoney(payments.reduce((s,p)=>s+squareFee(p.raw),0)); const taxes=roundMoney(numberValue(taxRows[0]?.tax_total)); const revenue=roundMoney(Math.max(0,amount-taxes)); const clearing=roundMoney(amount+tips-fees);
  const ids={clearing:await accountId('Tiki','1100'),sales:await accountId('Tiki','4100'),tax:await accountId('Tiki','2150'),tips:await accountId('Tiki','2160'),fees:await accountId('Tiki','5700')};
  const lines=[{accountId:ids.clearing,debit:clearing,credit:0},...(fees?[{accountId:ids.fees,debit:fees,credit:0}]:[]),...(revenue?[{accountId:ids.sales,debit:0,credit:revenue}]:[]),...(taxes?[{accountId:ids.tax,debit:0,credit:taxes}]:[]),...(tips?[{accountId:ids.tips,debit:0,credit:tips}]:[])]; assertBalancedJournalLines(lines);
  const entryId=crypto.randomUUID(); await sql.transaction([sql`INSERT INTO journal_entries (id,business,entry_date,description,source,reference,created_by) VALUES (${entryId},'Tiki',${input.businessDate},${`Square sales for ${input.businessDate}`},'Square',${reference},${input.actor})`,...lines.map((l)=>sql`INSERT INTO journal_lines (id,entry_id,account_id,debit,credit) VALUES (${crypto.randomUUID()},${entryId},${l.accountId},${l.debit},${l.credit})`)]);
  return {posted:true,journalEntryId:entryId,amount,tips,fees,taxes,revenue,clearing};
}

export async function accountingControlDashboard(business: Business) {
  await ensureAccountingControlSchema();
  const accounts = await getSql()`
    SELECT code, name, account_type FROM accounting_accounts
    WHERE business = ${business} AND active = TRUE ORDER BY code
  ` as unknown as Array<Record<string, unknown>>;
  const bankAccounts = await getSql()`
    SELECT external_account_id, institution_name, name, mask, current_balance, available_balance
    FROM bank_accounts WHERE business = ${business} AND active = TRUE ORDER BY institution_name, name
  ` as unknown as Array<Record<string, unknown>>;
  const transactions = await getSql()`
    SELECT t.id, t.external_account_id, t.transaction_date, t.merchant_name, t.description,
      t.signed_amount, t.direction, t.pending, t.category, t.account_code, t.review_status,
      t.classification_source, p.journal_entry_id, p.posted_at,
      COALESCE((SELECT SUM(s.amount) FROM bank_transaction_splits s WHERE s.bank_transaction_id = t.id), 0) AS split_total,
      EXISTS(SELECT 1 FROM bank_reconciliation_items ri WHERE ri.bank_transaction_id = t.id
        AND EXISTS(SELECT 1 FROM bank_reconciliations r WHERE r.id = ri.reconciliation_id AND r.status = 'Finalized')) AS reconciled
    FROM bank_transactions t
    LEFT JOIN bank_transaction_postings p ON p.bank_transaction_id = t.id
    WHERE t.business = ${business} AND t.removed = FALSE
    ORDER BY t.transaction_date DESC, t.created_at DESC
    LIMIT 300
  ` as unknown as Array<Record<string, unknown>>;
  const splits = await getSql()`
    SELECT bank_transaction_id, line_number, account_code, amount, memo
    FROM bank_transaction_splits
    WHERE bank_transaction_id IN (
      SELECT id FROM bank_transactions WHERE business = ${business} ORDER BY transaction_date DESC LIMIT 300
    ) ORDER BY bank_transaction_id, line_number
  ` as unknown as Array<Record<string, unknown>>;
  const reconciliations = await getSql()`
    SELECT r.*, COUNT(i.bank_transaction_id)::INTEGER AS item_count
    FROM bank_reconciliations r
    LEFT JOIN bank_reconciliation_items i ON i.reconciliation_id = r.id
    WHERE r.business = ${business}
    GROUP BY r.id ORDER BY r.statement_end_date DESC, r.created_at DESC LIMIT 40
  ` as unknown as Array<Record<string, unknown>>;
  const openingBalances = await getSql()`
    SELECT id, entry_date, description, reference, created_by, created_at
    FROM journal_entries WHERE business = ${business} AND source = 'Opening Balance'
    ORDER BY entry_date DESC, created_at DESC LIMIT 20
  ` as unknown as Array<Record<string, unknown>>;
  const unbalancedEntries = await getSql()`
    SELECT e.id, e.entry_date, e.description, e.source,
      COALESCE(SUM(l.debit),0) AS debits, COALESCE(SUM(l.credit),0) AS credits
    FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.business = ${business} AND e.source <> 'Reversal'
    GROUP BY e.id
    HAVING ABS(COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0)) > 0.005
    ORDER BY e.entry_date DESC, e.created_at DESC LIMIT 50
  ` as unknown as Array<Record<string, unknown>>;
  const monthly = await getSql()`
    SELECT TO_CHAR(DATE_TRUNC('month', e.entry_date), 'YYYY-MM') AS month,
      COALESCE(SUM(CASE WHEN a.account_type = 'Revenue' THEN l.credit - l.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN a.account_type = 'Expense' THEN l.debit - l.credit ELSE 0 END), 0) AS expenses
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id = e.id
    JOIN accounting_accounts a ON a.id = l.account_id
    WHERE e.business = ${business} AND e.entry_date >= CURRENT_DATE - INTERVAL '18 months'
    GROUP BY DATE_TRUNC('month', e.entry_date)
    ORDER BY DATE_TRUNC('month', e.entry_date)
  ` as unknown as Array<Record<string, unknown>>;
  const matches = business === "Tiki"
    ? await getSql()`
        SELECT m.id, m.bank_transaction_id, m.square_gross, m.square_fees, m.square_net,
          m.bank_amount, m.variance, m.status, m.matched_by, m.created_at, m.matched_at,
          t.transaction_date, t.merchant_name, t.description
        FROM square_deposit_matches m
        JOIN bank_transactions t ON t.id = m.bank_transaction_id
        ORDER BY t.transaction_date DESC, m.created_at DESC LIMIT 80
      ` as unknown as Array<Record<string, unknown>>
    : [];
  const squareDays = business === "Tiki"
    ? await getSql()`
        SELECT (created_at_square AT TIME ZONE 'America/New_York')::DATE AS business_date,
          COUNT(*)::INTEGER AS payments, COALESCE(SUM(amount), 0) AS amount,
          COALESCE(SUM(tip_amount), 0) AS tips,
          EXISTS(
            SELECT 1 FROM journal_entries e
            WHERE e.business = 'Tiki' AND e.source = 'Square'
              AND e.reference = CONCAT('square:', (p.created_at_square AT TIME ZONE 'America/New_York')::DATE::TEXT)
          ) AS posted
        FROM square_payments p
        WHERE status = 'COMPLETED' AND created_at_square >= NOW() - INTERVAL '60 days'
        GROUP BY (created_at_square AT TIME ZONE 'America/New_York')::DATE
        ORDER BY business_date DESC
      ` as unknown as Array<Record<string, unknown>>
    : [];

  const splitMap = new Map<string, Array<Record<string, unknown>>>();
  for (const split of splits) {
    const key = String(split.bank_transaction_id);
    splitMap.set(key, [...(splitMap.get(key) || []), {
      lineNumber: split.line_number,
      accountCode: split.account_code,
      amount: numberValue(split.amount),
      memo: split.memo,
    }]);
  }
  return {
    business,
    accounts: accounts.map((row) => ({ code: row.code, name: row.name, accountType: row.account_type })),
    bankAccounts: bankAccounts.map((row) => ({
      externalAccountId: row.external_account_id,
      institutionName: row.institution_name,
      name: row.name,
      mask: row.mask,
      currentBalance: row.current_balance === null ? null : numberValue(row.current_balance),
      availableBalance: row.available_balance === null ? null : numberValue(row.available_balance),
    })),
    transactions: transactions.map((row) => ({
      id: row.id,
      externalAccountId: row.external_account_id,
      transactionDate: row.transaction_date,
      merchantName: row.merchant_name,
      description: row.description,
      signedAmount: numberValue(row.signed_amount),
      direction: row.direction,
      pending: row.pending,
      category: row.category,
      accountCode: row.account_code,
      reviewStatus: row.review_status,
      classificationSource: row.classification_source,
      posted: Boolean(row.journal_entry_id),
      journalEntryId: row.journal_entry_id,
      postedAt: row.posted_at,
      reconciled: row.reconciled,
      splitTotal: numberValue(row.split_total),
      splits: splitMap.get(String(row.id)) || [],
    })),
    reconciliations: reconciliations.map((row) => ({
      id: row.id,
      externalAccountId: row.external_account_id,
      statementStartDate: row.statement_start_date,
      statementEndDate: row.statement_end_date,
      beginningBalance: numberValue(row.statement_beginning_balance),
      endingBalance: numberValue(row.statement_ending_balance),
      clearedActivity: numberValue(row.cleared_activity),
      difference: numberValue(row.difference),
      status: row.status,
      notes: row.notes,
      itemCount: numberValue(row.item_count),
      createdBy: row.created_by,
      finalizedBy: row.finalized_by,
      finalizedAt: row.finalized_at,
    })),
    openingBalances,
    unbalancedEntries: unbalancedEntries.map((row) => ({ id: row.id, entryDate: row.entry_date, description: row.description, source: row.source, debits: numberValue(row.debits), credits: numberValue(row.credits), difference: roundMoney(numberValue(row.debits) - numberValue(row.credits)) })),
    monthly: monthly.map((row) => ({
      month: row.month,
      revenue: numberValue(row.revenue),
      expenses: numberValue(row.expenses),
      profit: numberValue(row.revenue) - numberValue(row.expenses),
    })),
    squareDepositMatches: matches.map((row) => ({
      id: row.id,
      bankTransactionId: row.bank_transaction_id,
      transactionDate: row.transaction_date,
      merchantName: row.merchant_name,
      description: row.description,
      squareGross: numberValue(row.square_gross),
      squareFees: numberValue(row.square_fees),
      squareNet: numberValue(row.square_net),
      bankAmount: numberValue(row.bank_amount),
      variance: numberValue(row.variance),
      status: row.status,
      matchedBy: row.matched_by,
      createdAt: row.created_at,
      matchedAt: row.matched_at,
    })),
    squareDays: squareDays.map((row) => ({
      businessDate: row.business_date,
      payments: numberValue(row.payments),
      amount: numberValue(row.amount),
      tips: numberValue(row.tips),
      posted: row.posted,
    })),
  };
}

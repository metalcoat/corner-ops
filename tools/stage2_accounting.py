from pathlib import Path
import re
ROOT = Path(__file__).resolve().parents[1]

def rw(path): return (ROOT/path).read_text()
def ww(path,text): (ROOT/path).write_text(text)
def rep(path,old,new):
    t=rw(path); c=t.count(old)
    if c!=1: raise RuntimeError(f'{path}: expected 1 match, found {c}: {old[:90]!r}')
    ww(path,t.replace(old,new,1))
def sub(path,pat,new):
    t=rw(path); n,c=re.subn(pat,lambda m:new,t,count=1,flags=re.S)
    if c!=1: raise RuntimeError(f'{path}: regex match count {c}: {pat[:90]}')
    ww(path,n)

# Imports.
rep('src/lib/accounting-control.ts',
'''import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { ensureSchema, getSql } from "@/lib/db";
import { ensureIntegrationSchema } from "@/lib/integrations";
import type { Business } from "@/lib/types";
''',
'''import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { codedHistoryBaseKey, nextOccurrence, parseAccountingMoney } from "@/lib/accounting-import-utils";
import { ensureSchema, getSql } from "@/lib/db";
import { ValidationError } from "@/lib/http";
import { ensureIntegrationSchema } from "@/lib/integrations";
import { assertBalancedJournalLines } from "@/lib/journal-integrity";
import type { Business } from "@/lib/types";
''')

# Atomic legacy bank poster.
sub('src/lib/accounting-control.ts', r'export async function postBankTransaction\(input: \{ transactionId: string; business: Business; actor: string \}\) \{.*?\n\}\n\nexport async function postAllApprovedBankTransactions', '''export async function postBankTransaction(input: { transactionId: string; business: Business; actor: string }) {
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

export async function postAllApprovedBankTransactions''')

# Business scope on reconciliation and reopen.
rep('src/lib/accounting-control.ts','SELECT status FROM bank_reconciliations WHERE id = ${id} LIMIT 1','SELECT status FROM bank_reconciliations WHERE id = ${id} AND business = ${input.business} LIMIT 1')
rep('src/lib/accounting-control.ts','      WHERE id = ${id}\n    `;\n    await getSql()`DELETE FROM bank_reconciliation_items WHERE reconciliation_id = ${id}`;','      WHERE id = ${id} AND business = ${input.business}\n    `;\n    await getSql()`DELETE FROM bank_reconciliation_items WHERE reconciliation_id = ${id} AND EXISTS (SELECT 1 FROM bank_reconciliations WHERE id = ${id} AND business = ${input.business})`;')
sub('src/lib/accounting-control.ts', r'export async function reopenBankReconciliation\(id: string, actor: string\) \{.*?\n\}', '''export async function reopenBankReconciliation(id: string, business: Business, actor: string) {
  await ensureAccountingControlSchema();
  const rows = await getSql()`
    UPDATE bank_reconciliations SET status = 'Reopened', finalized_by = NULL, finalized_at = NULL,
      notes = CONCAT(notes, CASE WHEN notes = '' THEN '' ELSE E'\\n' END, ${`Reopened by ${actor} on ${new Date().toISOString()}`}), updated_at = NOW()
    WHERE id = ${id} AND business = ${business} AND status = 'Finalized'
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new ValidationError("Only finalized reconciliations in this business can be reopened.");
  return { reopened: true };
}''')

# Stable coded-history identity, robust money parsing, and a real control account.
sub('src/lib/accounting-control.ts', r'export async function importCodedHistory\(input: \{.*?\n\}\n\nfunction squareFee', '''export async function importCodedHistory(input: {
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

function squareFee''')

# Atomic Square day poster.
sub('src/lib/accounting-control.ts', r'export async function postSquareDay\(input: \{ businessDate: string; actor: string \}\) \{.*?\n\}\n\nexport async function accountingControlDashboard', '''export async function postSquareDay(input: { businessDate: string; actor: string }) {
  await ensureAccountingControlSchema();
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(input.businessDate)) throw new ValidationError("Choose a valid Square business date.");
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

export async function accountingControlDashboard''')

# API: Square branches must require Tiki; coded history gets account type; reopen scopes business.
rep('src/app/api/accounting-control/route.ts',
'''    if (action === "square-match-build") return Response.json(await buildSquareDepositSuggestions(session.email));
    if (action === "square-match-status") return Response.json(await setSquareDepositMatchStatus({
      id: String(body.id || ""), status: body.status === "Ignored" ? "Ignored" : "Matched", actor: session.email,
    }));
    if (action === "square-day-post") return Response.json(await postSquareDay({ businessDate: String(body.businessDate || ""), actor: session.email }));
''',
'''    if (["square-match-build", "square-match-status", "square-day-post"].includes(action) && !canAccessBusiness(session, "Tiki")) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    if (action === "square-match-build") return Response.json(await buildSquareDepositSuggestions(session.email));
    if (action === "square-match-status") return Response.json(await setSquareDepositMatchStatus({ id: String(body.id || ""), status: body.status === "Ignored" ? "Ignored" : "Matched", actor: session.email }));
    if (action === "square-day-post") return Response.json(await postSquareDay({ businessDate: String(body.businessDate || ""), actor: session.email }));
''')
rep('src/app/api/accounting-control/route.ts','        postApproved: String(form.get("postApproved") || "") === "true",\n        actor: session.email,','        accountType: form.get("accountType") === "credit" ? "credit" : "depository",\n        postApproved: String(form.get("postApproved") || "") === "true",\n        actor: session.email,')
rep('src/app/api/accounting-control/route.ts','if (action === "reconciliation-reopen") return Response.json(await reopenBankReconciliation(String(body.id || ""), session.email));','if (action === "reconciliation-reopen") return Response.json(await reopenBankReconciliation(String(body.id || ""), business, session.email));')

# Card statement matches must come from cash/bank accounts, never the credit-card feed itself.
rep('src/lib/card-statements.ts','    FROM bank_transactions\n    WHERE business = ${business}','    FROM bank_transactions t\n    JOIN bank_accounts a ON a.external_account_id = t.external_account_id\n    WHERE t.business = ${business}\n      AND a.account_type <> \'credit\'')
rep('src/lib/card-statements.ts','    SELECT s.id\n    FROM credit_card_statements s\n    JOIN bank_transactions t ON t.id = ${input.bankTransactionId} AND t.business = s.business','    SELECT s.id\n    FROM credit_card_statements s\n    JOIN bank_transactions t ON t.id = ${input.bankTransactionId} AND t.business = s.business\n    JOIN bank_accounts a ON a.external_account_id = t.external_account_id AND a.account_type <> \'credit\'')

print('Stage 2 accounting transformations applied')

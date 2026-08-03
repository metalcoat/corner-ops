import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { getSql } from "@/lib/db";
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

async function accountId(business: Business, code: string): Promise<string> {
  const rows = await getSql()`
    SELECT id FROM accounting_accounts
    WHERE business = ${business} AND code = ${clean(code, 20)} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error(`Accounting account ${code} was not found for ${business}.`);
  return rows[0].id;
}

async function loadTransaction(id: string, business: Business) {
  const rows = await getSql()`
    SELECT t.id, t.business, t.external_transaction_id, t.external_account_id,
      t.transaction_date, t.merchant_name, t.description, t.signed_amount,
      t.pending, t.removed, t.account_code, t.review_status,
      a.account_type, a.account_subtype, a.name AS account_name
    FROM bank_transactions t
    LEFT JOIN bank_accounts a ON a.external_account_id = t.external_account_id
    WHERE t.id = ${id} AND t.business = ${business}
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new Error("Bank or credit-card transaction was not found.");
  return rows[0];
}

export async function postFinancialTransaction(input: {
  transactionId: string;
  business: Business;
  actor: string;
}) {
  await ensureAccountingControlSchema();
  await getSql()`ALTER TABLE bank_transaction_splits ADD COLUMN IF NOT EXISTS invoice_id UUID`;
  const transaction = await loadTransaction(input.transactionId, input.business);
  if (transaction.pending) throw new Error("Pending transactions cannot be posted.");
  if (transaction.removed) throw new Error("Removed transactions cannot be posted.");
  if (transaction.review_status !== "Approved") throw new Error("Approve the transaction before posting it.");

  const existing = await getSql()`
    SELECT journal_entry_id FROM bank_transaction_postings
    WHERE bank_transaction_id = ${input.transactionId}
    LIMIT 1
  ` as unknown as Array<{ journal_entry_id: string }>;
  if (existing[0]) return { posted: false, journalEntryId: existing[0].journal_entry_id, duplicate: true };

  const splitRows = await getSql()`
    SELECT account_code, amount, memo, invoice_id FROM bank_transaction_splits
    WHERE bank_transaction_id = ${input.transactionId}
    ORDER BY line_number
  ` as unknown as Array<{ account_code: string; amount: string | number; memo: string; invoice_id: string | null }>;
  const amount = roundMoney(Math.abs(numberValue(transaction.signed_amount)));
  const categoryLines = splitRows.length
    ? splitRows.map((row) => ({
        code: row.invoice_id ? "1200" : clean(row.account_code, 20),
        amount: roundMoney(numberValue(row.amount)),
        memo: row.memo,
      }))
    : [{ code: clean(transaction.account_code, 20), amount, memo: "" }];
  if (!categoryLines[0].code) throw new Error("Choose an accounting account before posting.");
  if (Math.abs(categoryLines.reduce((sum, line) => sum + line.amount, 0) - amount) > 0.005) {
    throw new Error("Transaction splits no longer equal the imported amount.");
  }

  const controlCode = transaction.account_type === "credit" ? "2100" : "1000";
  const controlId = await accountId(input.business, controlCode);
  const categoryIds = new Map<string, string>();
  for (const line of categoryLines) categoryIds.set(line.code, await accountId(input.business, line.code));

  const entryId = crypto.randomUUID();
  const description = clean(transaction.merchant_name || transaction.description, 240)
    || (transaction.account_type === "credit" ? "Credit-card transaction" : "Bank transaction");
  const source = transaction.account_type === "credit" ? "Credit Card Import" : "Bank Import";
  await getSql()`
    INSERT INTO journal_entries (id, business, entry_date, description, source, reference, created_by)
    VALUES (
      ${entryId}, ${input.business}, ${String(transaction.transaction_date)}, ${description},
      ${source}, ${`financial:${transaction.external_transaction_id}`}, ${input.actor}
    )
  `;

  try {
    if (numberValue(transaction.signed_amount) > 0) {
      await getSql()`
        INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
        VALUES (${crypto.randomUUID()}, ${entryId}, ${controlId}, ${amount}, 0)
      `;
      for (const line of categoryLines) {
        await getSql()`
          INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
          VALUES (${crypto.randomUUID()}, ${entryId}, ${categoryIds.get(line.code)!}, 0, ${line.amount})
        `;
      }
    } else {
      for (const line of categoryLines) {
        await getSql()`
          INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
          VALUES (${crypto.randomUUID()}, ${entryId}, ${categoryIds.get(line.code)!}, ${line.amount}, 0)
        `;
      }
      await getSql()`
        INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
        VALUES (${crypto.randomUUID()}, ${entryId}, ${controlId}, 0, ${amount})
      `;
    }
    await getSql()`
      INSERT INTO bank_transaction_postings (id, bank_transaction_id, journal_entry_id, posted_by)
      VALUES (${crypto.randomUUID()}, ${input.transactionId}, ${entryId}, ${input.actor})
    `;
  } catch (error) {
    await getSql()`DELETE FROM journal_entries WHERE id = ${entryId}`;
    throw error;
  }
  return { posted: true, journalEntryId: entryId, controlAccount: controlCode };
}

export async function postAllApprovedFinancialTransactions(input: { business: Business; actor: string }) {
  await ensureAccountingControlSchema();
  const rows = await getSql()`
    SELECT t.id
    FROM bank_transactions t
    LEFT JOIN bank_transaction_postings p ON p.bank_transaction_id = t.id
    WHERE t.business = ${input.business}
      AND t.review_status = 'Approved'
      AND t.pending = FALSE
      AND t.removed = FALSE
      AND p.id IS NULL
    ORDER BY t.transaction_date, t.created_at
  ` as unknown as Array<{ id: string }>;
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const row of rows) {
    try {
      await postFinancialTransaction({ transactionId: row.id, business: input.business, actor: input.actor });
      results.push({ id: row.id, ok: true });
    } catch (error) {
      results.push({ id: row.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { attempted: rows.length, posted: results.filter((result) => result.ok).length, results };
}

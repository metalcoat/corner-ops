import { getSql } from "@/lib/db";
import { assertBalancedJournalLines } from "@/lib/journal-integrity";
import type { Business } from "@/lib/types";

type PostedRow = {
  bank_transaction_id: string;
  journal_entry_id: string;
  entry_date: string;
  description: string;
};

type LineRow = {
  account_id: string;
  debit: string | number;
  credit: string | number;
};

export async function reverseJournalEntry(input: {
  entryId: string;
  business: Business;
  actor: string;
  reason: string;
}) {
  const sql = getSql();
  const entries = await sql`
    SELECT id, entry_date, description, source FROM journal_entries
    WHERE id = ${input.entryId} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{ id: string; entry_date: string; description: string; source: string }>;
  const source = entries[0];
  if (!source) throw new Error("Journal entry was not found for this business.");
  if (source.source === "Reversal") throw new Error("Reverse the original entry, not an existing reversal.");
  const reference = `reversal:${source.id}`;
  const existing = await sql`SELECT id FROM journal_entries WHERE business = ${input.business} AND source = 'Reversal' AND reference = ${reference} LIMIT 1` as unknown as Array<{ id: string }>;
  if (existing[0]) return { reversed: false, duplicate: true, reversalEntryId: existing[0].id };
  const lines = await sql`SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = ${source.id} ORDER BY id` as unknown as LineRow[];
  if (!lines.length) throw new Error("Journal entry has no lines to reverse.");
  const reversed = lines.map((line) => ({ accountId: line.account_id, debit: Number(line.credit || 0), credit: Number(line.debit || 0) }));
  assertBalancedJournalLines(reversed);
  const reversalEntryId = crypto.randomUUID();
  await sql.transaction([
    sql`INSERT INTO journal_entries (id,business,entry_date,description,source,reference,created_by) VALUES (${reversalEntryId},${input.business},${source.entry_date},${`Reversal: ${source.description} — ${input.reason}`.slice(0,240)},'Reversal',${reference},${input.actor})`,
    ...reversed.map((line) => sql`INSERT INTO journal_lines (id,entry_id,account_id,debit,credit) VALUES (${crypto.randomUUID()},${reversalEntryId},${line.accountId},${line.debit},${line.credit})`),
  ]);
  return { reversed: true, reversalEntryId, originalEntryId: source.id };
}

export async function reversePostedBankTransaction(input: {
  transactionId: string;
  business: Business;
  actor: string;
  reason: string;
}) {
  const sql = getSql();
  const posted = await sql`
    SELECT p.bank_transaction_id, p.journal_entry_id, e.entry_date, e.description
    FROM bank_transaction_postings p
    JOIN journal_entries e ON e.id = p.journal_entry_id
    WHERE p.bank_transaction_id = ${input.transactionId} AND e.business = ${input.business}
    LIMIT 1
  ` as unknown as PostedRow[];
  const source = posted[0];
  if (!source) return { reversed: false, reason: "Transaction is not posted." };

  const reference = `reversal:${source.journal_entry_id}`;
  const existing = await sql`
    SELECT id FROM journal_entries
    WHERE business = ${input.business} AND source = 'Reversal' AND reference = ${reference}
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (existing[0]) {
    await sql`DELETE FROM bank_transaction_postings WHERE bank_transaction_id = ${input.transactionId}`;
    return { reversed: false, duplicate: true, reversalEntryId: existing[0].id };
  }

  const lines = await sql`
    SELECT account_id, debit, credit FROM journal_lines
    WHERE entry_id = ${source.journal_entry_id}
    ORDER BY id
  ` as unknown as LineRow[];
  if (!lines.length) throw new Error("Posted journal entry has no lines to reverse.");

  const reversed = lines.map((line) => ({
    accountId: line.account_id,
    debit: Number(line.credit || 0),
    credit: Number(line.debit || 0),
  }));
  assertBalancedJournalLines(reversed);

  const reversalEntryId = crypto.randomUUID();
  const queries = [
    sql`
      INSERT INTO journal_entries (id, business, entry_date, description, source, reference, created_by)
      VALUES (
        ${reversalEntryId}, ${input.business}, ${source.entry_date},
        ${`Reversal: ${source.description} — ${input.reason}`.slice(0, 240)},
        'Reversal', ${reference}, ${input.actor}
      )
    `,
    ...reversed.map((line) => sql`
      INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
      VALUES (${crypto.randomUUID()}, ${reversalEntryId}, ${line.accountId}, ${line.debit}, ${line.credit})
    `),
    sql`DELETE FROM bank_transaction_postings WHERE bank_transaction_id = ${input.transactionId}`,
  ];
  await sql.transaction(queries);
  return { reversed: true, reversalEntryId, originalEntryId: source.journal_entry_id };
}

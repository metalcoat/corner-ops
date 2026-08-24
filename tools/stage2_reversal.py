from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def r(p): return (ROOT/p).read_text()
def w(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
 t=r(p); c=t.count(o)
 if c!=1: raise RuntimeError(f'{p}: expected 1 match, got {c}: {o[:100]!r}')
 w(p,t.replace(o,n,1))

# Generic owner-triggered journal reversal for repair work.
rep('src/lib/journal-reversal.ts','export async function reversePostedBankTransaction(input: {','''export async function reverseJournalEntry(input: {
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

export async function reversePostedBankTransaction(input: {''')

rep('src/app/api/accounting-control/route.ts','import { apiError, unauthorized } from "@/lib/http";','import { apiError, unauthorized } from "@/lib/http";\nimport { reverseJournalEntry } from "@/lib/journal-reversal";')
rep('src/app/api/accounting-control/route.ts','''    if (action === "reconciliation-reopen") return Response.json(await reopenBankReconciliation(String(body.id || ""), business, session.email));
    return Response.json({ error: "Unknown accounting action." }, { status: 400 });
''','''    if (action === "reconciliation-reopen") return Response.json(await reopenBankReconciliation(String(body.id || ""), business, session.email));
    if (action === "journal-reverse") return Response.json(await reverseJournalEntry({
      entryId: String(body.entryId || ""), business, actor: session.email, reason: String(body.reason || "Manual accounting correction"),
    }));
    return Response.json({ error: "Unknown accounting action." }, { status: 400 });
''')

# Dashboard exposes entries that are actually out of balance so the owner has a repair path.
rep('src/lib/accounting-control.ts','''  const monthly = await getSql()`
    SELECT TO_CHAR(DATE_TRUNC('month', e.entry_date), 'YYYY-MM') AS month,
''','''  const unbalancedEntries = await getSql()`
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
''')
rep('src/lib/accounting-control.ts','''    openingBalances,
    monthly: monthly.map((row) => ({
''','''    openingBalances,
    unbalancedEntries: unbalancedEntries.map((row) => ({ id: row.id, entryDate: row.entry_date, description: row.description, source: row.source, debits: numberValue(row.debits), credits: numberValue(row.credits), difference: roundMoney(numberValue(row.debits) - numberValue(row.credits)) })),
    monthly: monthly.map((row) => ({
''')

# Minimal repair UI in advanced accounting.
rep('src/app/ops/accounting-control/page.tsx','''  reconciliations: Array<Record<string, unknown>>;
  monthly: Array<{ month: string; revenue: number; expenses: number; profit: number }>;
''','''  reconciliations: Array<Record<string, unknown>>;
  unbalancedEntries: Array<{ id: string; entryDate: string; description: string; source: string; debits: number; credits: number; difference: number }>;
  monthly: Array<{ month: string; revenue: number; expenses: number; profit: number }>;
''')
rep('src/app/ops/accounting-control/page.tsx','''        <section><p className="eyebrow">18-month trend</p><h2>Monthly profit</h2><div className="chartBars">''','''        <section><p className="eyebrow">Ledger repair</p><h2>Unbalanced entries</h2>{data?.unbalancedEntries.length ? <div className="controlList">{data.unbalancedEntries.map((entry) => <div key={entry.id}><strong>{entry.entryDate} · {entry.description}</strong><small>{entry.source} · difference {dollars(entry.difference)}</small><button disabled={busy} onClick={() => void post({ action: "journal-reverse", business, entryId: entry.id, reason: "Reversed from accounting control after balance review" }).then(() => setNotice("Journal entry reversed."))}>Reverse entry</button></div>)}</div> : <p>No unbalanced entries detected.</p>}</section>
        <section><p className="eyebrow">18-month trend</p><h2>Monthly profit</h2><div className="chartBars">''')

print('Stage 2 reversal transformations applied')

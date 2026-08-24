from pathlib import Path
import re
ROOT=Path(__file__).resolve().parents[1]
def r(p): return (ROOT/p).read_text()
def w(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
 t=r(p); c=t.count(o)
 if c!=1: raise RuntimeError(f'{p}: expected 1 match, got {c}: {o[:100]!r}')
 w(p,t.replace(o,n,1))
def sub(p,pat,n):
 t=r(p); x,c=re.subn(pat,lambda m:n,t,count=1,flags=re.S)
 if c!=1: raise RuntimeError(f'{p}: regex count {c}: {pat[:100]}')
 w(p,x)

rep('src/lib/bank-posting.ts','import { getSql } from "@/lib/db";\nimport type { Business } from "@/lib/types";','import { getSql } from "@/lib/db";\nimport { ValidationError } from "@/lib/http";\nimport { assertBalancedJournalLines } from "@/lib/journal-integrity";\nimport type { Business } from "@/lib/types";')

sub('src/lib/bank-posting.ts',r'export async function postFinancialTransaction\(input: \{.*?\n\}\n\nexport async function postAllApprovedFinancialTransactions', '''export async function postFinancialTransaction(input: {
  transactionId: string; business: Business; actor: string;
}) {
  await ensureAccountingControlSchema();
  const transaction = await loadTransaction(input.transactionId, input.business);
  if (transaction.pending) throw new ValidationError("Pending transactions cannot be posted.");
  if (transaction.removed) throw new ValidationError("Removed transactions cannot be posted.");
  if (transaction.review_status !== "Approved") throw new ValidationError("Approve the transaction before posting it.");
  const sql=getSql();
  const existing=await sql`SELECT journal_entry_id FROM bank_transaction_postings WHERE bank_transaction_id=${input.transactionId} LIMIT 1` as unknown as Array<{journal_entry_id:string}>;
  if(existing[0]) return {posted:false,journalEntryId:existing[0].journal_entry_id,duplicate:true};
  const splitRows=await sql`SELECT account_code,amount,memo,invoice_id FROM bank_transaction_splits WHERE bank_transaction_id=${input.transactionId} ORDER BY line_number` as unknown as Array<{account_code:string;amount:string|number;memo:string;invoice_id:string|null}>;
  const amount=roundMoney(Math.abs(numberValue(transaction.signed_amount)));
  const categoryLines=splitRows.length?splitRows.map((row)=>({code:row.invoice_id?"1200":clean(row.account_code,20),amount:roundMoney(numberValue(row.amount))})):[{code:clean(transaction.account_code,20),amount}];
  if(!categoryLines[0].code) throw new ValidationError("Choose an accounting account before posting.");
  if(Math.abs(categoryLines.reduce((s,l)=>s+l.amount,0)-amount)>0.005) throw new ValidationError("Transaction splits no longer equal the imported amount.");
  const controlCode=transaction.account_type==="credit"?"2100":"1000"; const controlId=await accountId(input.business,controlCode); const categoryIds=new Map<string,string>(); for(const l of categoryLines) categoryIds.set(l.code,await accountId(input.business,l.code));
  const positive=numberValue(transaction.signed_amount)>0;
  const journalLines=positive?[{accountId:controlId,debit:amount,credit:0},...categoryLines.map((l)=>({accountId:categoryIds.get(l.code)!,debit:0,credit:l.amount}))]:[...categoryLines.map((l)=>({accountId:categoryIds.get(l.code)!,debit:l.amount,credit:0})),{accountId:controlId,debit:0,credit:amount}];
  assertBalancedJournalLines(journalLines);
  const entryId=crypto.randomUUID(); const description=clean(transaction.merchant_name||transaction.description,240)||(transaction.account_type==="credit"?"Credit-card transaction":"Bank transaction"); const source=transaction.account_type==="credit"?"Credit Card Import":"Bank Import";
  await sql.transaction([sql`INSERT INTO journal_entries (id,business,entry_date,description,source,reference,created_by) VALUES (${entryId},${input.business},${String(transaction.transaction_date)},${description},${source},${`financial:${transaction.external_transaction_id}`},${input.actor})`,...journalLines.map((l)=>sql`INSERT INTO journal_lines (id,entry_id,account_id,debit,credit) VALUES (${crypto.randomUUID()},${entryId},${l.accountId},${l.debit},${l.credit})`),sql`INSERT INTO bank_transaction_postings (id,bank_transaction_id,journal_entry_id,posted_by) VALUES (${crypto.randomUUID()},${input.transactionId},${entryId},${input.actor})`]);
  return {posted:true,journalEntryId:entryId,controlAccount:controlCode};
}

export async function postAllApprovedFinancialTransactions''')

# The invoice_id schema is migration-owned now; posting may not execute DDL.
if 'ALTER TABLE bank_transaction_splits ADD COLUMN IF NOT EXISTS invoice_id UUID' in r('src/lib/bank-posting.ts'):
    raise RuntimeError('runtime ALTER TABLE remained after function replacement')

# History import UI asks which control account is being imported.
rep('src/app/ops/accounting-control/page.tsx','''<section><p className="eyebrow">History migration</p><h2>Import coded workbook</h2><form className="controlForm" onSubmit={historyImport}><label>Institution/source<input name="institutionName" defaultValue="Historical bookkeeping" /></label><label>Workbook<input name="file" type="file" accept=".xlsx,.xls,.csv" required /></label><label className="wide"><span><input name="postApproved" type="checkbox" /> Post imported approved rows immediately</span></label><button className="primary" disabled={busy}>Import history</button></form></section>''','''<section><p className="eyebrow">History migration</p><h2>Import coded workbook</h2><form className="controlForm" onSubmit={historyImport}><label>Institution/source<input name="institutionName" defaultValue="Historical bookkeeping" /></label><label>Control account<select name="accountType" defaultValue="depository"><option value="depository">Bank / cash account</option><option value="credit">Credit-card account</option></select></label><label>Workbook<input name="file" type="file" accept=".xlsx,.xls,.csv" required /></label><label className="wide"><span><input name="postApproved" type="checkbox" /> Post imported approved rows immediately</span></label><button className="primary" disabled={busy}>Import history</button></form></section>''')

print('Stage 2 financial posting transformations applied')

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

rep('src/lib/integrations.ts',
'import { ensureSchema, getSql } from "@/lib/db";\nimport type { Business } from "@/lib/types";\n',
'import { ensureSchema, getSql } from "@/lib/db";\nimport { ValidationError } from "@/lib/http";\nimport { reversePostedBankTransaction } from "@/lib/journal-reversal";\nimport type { Business } from "@/lib/types";\n')

# CO-015: sync must not undo owner account exclusions.
rep('src/lib/integrations.ts','        active = TRUE,\n        updated_at = NOW()','        active = bank_accounts.active,\n        updated_at = NOW()')

# CO-043: one Plaid item cannot jump legal entities during relink.
needle='''  const institution = clean(input.institutionName, 120)
    || await institutionName(item.item?.institution_id || "");

  const rows = await getSql()`
'''
insert='''  const institution = clean(input.institutionName, 120)
    || await institutionName(item.item?.institution_id || "");
  const existingItem = await getSql()`
    SELECT business FROM integration_connections
    WHERE provider = 'Plaid' AND external_item_id = ${exchanged.item_id}
    LIMIT 1
  ` as unknown as Array<{ business: Business }>;
  if (existingItem[0] && existingItem[0].business !== input.business) {
    throw new ValidationError(`This Plaid item is already assigned to ${existingItem[0].business}. Disconnect it there before moving it.`);
  }

  const rows = await getSql()`
'''
rep('src/lib/integrations.ts',needle,insert)

# Business-scoped connection loading for user-driven syncs.
sub('src/lib/integrations.ts',r'async function loadConnection\(connectionId: string\): Promise<ConnectionRow> \{.*?\n\}', '''async function loadConnection(connectionId: string, expectedBusiness?: Business): Promise<ConnectionRow> {
  const rows = expectedBusiness
    ? await getSql()`
        SELECT id, provider, business, institution_name, external_item_id, encrypted_access_token,
          encrypted_refresh_token, token_expires_at, cursor, status, metadata, last_sync_at, created_at, updated_at
        FROM integration_connections WHERE id = ${connectionId} AND business = ${expectedBusiness} LIMIT 1
      ` as unknown as ConnectionRow[]
    : await getSql()`
        SELECT id, provider, business, institution_name, external_item_id, encrypted_access_token,
          encrypted_refresh_token, token_expires_at, cursor, status, metadata, last_sync_at, created_at, updated_at
        FROM integration_connections WHERE id = ${connectionId} LIMIT 1
      ` as unknown as ConnectionRow[];
  if (!rows[0]) throw new ValidationError("Integration connection was not found for this business.");
  return rows[0];
}''')
rep('src/lib/integrations.ts','export async function syncBankConnection(connectionId: string) {\n  await ensureIntegrationSchema();\n  const connection = await loadConnection(connectionId);','export async function syncBankConnection(connectionId: string, expectedBusiness?: Business) {\n  await ensureIntegrationSchema();\n  const connection = await loadConnection(connectionId, expectedBusiness);')

# CO-016: posted amount changes/removals are reversed before the feed row changes.
rep('src/lib/integrations.ts','''      for (const transaction of page.modified || []) {
        await upsertPlaidTransaction(connection, transaction, rules, true);
        modified += 1;
      }
      for (const transaction of page.removed || []) {
        await getSql()`
          UPDATE bank_transactions SET removed = TRUE, updated_at = NOW()
          WHERE external_transaction_id = ${transaction.transaction_id}
        `;
        removed += 1;
      }
''','''      for (const transaction of page.modified || []) {
        const current = await getSql()`
          SELECT id, signed_amount FROM bank_transactions
          WHERE external_transaction_id = ${transaction.transaction_id} AND business = ${connection.business}
          LIMIT 1
        ` as unknown as Array<{ id: string; signed_amount: string | number }>;
        const nextAmount = Math.round(-numberValue(transaction.amount) * 100) / 100;
        const amountChanged = current[0] && Math.abs(numberValue(current[0].signed_amount) - nextAmount) > 0.005;
        let reversal = null;
        if (current[0] && amountChanged) {
          reversal = await reversePostedBankTransaction({
            transactionId: current[0].id,
            business: connection.business,
            actor: "Plaid sync",
            reason: `Plaid changed amount to ${nextAmount.toFixed(2)}`,
          });
        }
        await upsertPlaidTransaction(connection, transaction, rules, true);
        if (current[0] && amountChanged) {
          await getSql()`UPDATE bank_transactions SET review_status = 'Needs Review', updated_at = NOW() WHERE id = ${current[0].id} AND business = ${connection.business}`;
          if (reversal?.reversed) await createOperationIssue({
            issueKey: `plaid-posted-modified:${current[0].id}`,
            business: connection.business,
            issueType: "Ledger Feed Change",
            severity: "Warning",
            title: "Posted bank transaction changed in Plaid",
            details: `The prior journal entry was reversed because Plaid changed the transaction amount to ${nextAmount.toFixed(2)}. Review and repost the updated transaction.`,
            reference: current[0].id,
          });
        }
        modified += 1;
      }
      for (const transaction of page.removed || []) {
        const current = await getSql()`SELECT id FROM bank_transactions WHERE external_transaction_id = ${transaction.transaction_id} AND business = ${connection.business} LIMIT 1` as unknown as Array<{ id: string }>;
        if (current[0]) {
          const reversal = await reversePostedBankTransaction({ transactionId: current[0].id, business: connection.business, actor: "Plaid sync", reason: "Plaid removed the transaction" });
          await getSql()`UPDATE bank_transactions SET removed = TRUE, review_status = 'Needs Review', updated_at = NOW() WHERE id = ${current[0].id} AND business = ${connection.business}`;
          if (reversal.reversed) await createOperationIssue({
            issueKey: `plaid-posted-removed:${current[0].id}`,
            business: connection.business,
            issueType: "Ledger Feed Change",
            severity: "Warning",
            title: "Posted bank transaction was removed by Plaid",
            details: "The prior journal entry was reversed and the bank transaction was hidden from normal posting until reviewed.",
            reference: current[0].id,
          });
        }
        removed += 1;
      }
''')

# CO-041: dashboards are always business scoped; global scheduler data only for multi-business users.
sub('src/lib/integrations.ts',r'export async function integrationDashboard\(business\?: Business\) \{.*?\n  return \{', '''export async function integrationDashboard(business: Business, includeGlobal = false) {
  await ensureIntegrationSchema();
  const connections = await getSql()`SELECT id, provider, business, institution_name, status, metadata, last_sync_at, created_at, updated_at FROM integration_connections WHERE business = ${business} ORDER BY provider, created_at` as unknown as Array<Record<string, unknown>>;
  const accounts = await getSql()`SELECT id, business, institution_name, name, official_name, mask, account_type, account_subtype, current_balance, available_balance, currency, active, updated_at FROM bank_accounts WHERE business = ${business} ORDER BY institution_name, name` as unknown as Array<Record<string, unknown>>;
  const transactions = await getSql()`SELECT id, transaction_date, merchant_name, description, signed_amount, direction, pending, category, account_code, classification_source, confidence, review_status, user_override FROM bank_transactions WHERE business = ${business} AND removed = FALSE ORDER BY transaction_date DESC, created_at DESC LIMIT 150` as unknown as Array<Record<string, unknown>>;
  const accountingAccounts = await getSql()`SELECT code, name, account_type FROM accounting_accounts WHERE business = ${business} AND active = TRUE ORDER BY code` as unknown as Array<Record<string, unknown>>;
  const syncRuns = await getSql()`SELECT id, connection_id, provider, business, status, records_added, records_modified, records_removed, message, started_at, completed_at FROM integration_sync_runs WHERE business = ${business} ORDER BY started_at DESC LIMIT 40` as unknown as Array<Record<string, unknown>>;
  const issues = await getSql()`SELECT id, business, issue_type, severity, title, details, reference, status, first_seen_at, last_seen_at FROM operation_issues WHERE business = ${business} AND status = 'Open' ORDER BY severity DESC, last_seen_at DESC LIMIT 50` as unknown as Array<Record<string, unknown>>;
  const schedulerRuns = includeGlobal ? await getSql()`SELECT id, run_key, local_date, local_hour, status, details, started_at, completed_at FROM scheduler_runs ORDER BY started_at DESC LIMIT 20` as unknown as Array<Record<string, unknown>> : [];
  const payrollRuns = await getSql()`SELECT id, business, week_start, week_end, status, generated_by, generated_at, updated_at FROM payroll_runs WHERE business = ${business} ORDER BY week_start DESC LIMIT 20` as unknown as Array<Record<string, unknown>>;
  const squareSummary = business === "Tiki" ? await getSql()`SELECT COALESCE(SUM(amount), 0) AS sales, COALESCE(SUM(tip_amount), 0) AS tips, COUNT(*) AS payments FROM square_payments WHERE status = 'COMPLETED' AND created_at_square >= NOW() - INTERVAL '30 days'` as unknown as Array<Record<string, unknown>> : [];

  return {''')

# API always chooses an accessible business, scopes live sync actions, and limits forced scheduler to multi-business users.
rep('src/app/api/integrations/route.ts','''    const value = new URL(request.url).searchParams.get("business");
    const business = value ? businessFrom(value) : undefined;
    if (business && !canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json(await integrationDashboard(business));
''','''    const value = new URL(request.url).searchParams.get("business");
    const business = value ? businessFrom(value) : session.businesses[0];
    if (!business || !canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json(await integrationDashboard(business, session.businesses.length > 1));
''')
rep('src/app/api/integrations/route.ts','return Response.json(await syncBankConnection(String(body.connectionId || "")));','return Response.json(await syncBankConnection(String(body.connectionId || ""), business));')
rep('src/app/api/integrations/route.ts','''    if (action === "bank-sync") {
      return Response.json(await syncBankConnection(String(body.connectionId || "")));
    }

    if (action === "square-sync") {
      return Response.json(await syncSquareConnection(body.connectionId ? String(body.connectionId) : undefined));
    }
''','''    if (action === "bank-sync") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
      return Response.json(await syncBankConnection(String(body.connectionId || ""), business));
    }

    if (action === "square-sync") {
      if (!canAccessBusiness(session, "Tiki")) return Response.json({ error: "Business access denied." }, { status: 403 });
      return Response.json(await syncSquareConnection(body.connectionId ? String(body.connectionId) : undefined));
    }
''')
rep('src/app/api/integrations/route.ts','''    if (action === "scheduler-run") {
      return Response.json(await runScheduledOperations({ force: true, source: session.email }));
    }
''','''    if (action === "scheduler-run") {
      if (session.businesses.length < 2) return Response.json({ error: "Both-business access is required to force the global scheduler." }, { status: 403 });
      return Response.json(await runScheduledOperations({ force: true, source: session.email }));
    }
''')

print('Stage 2 integration transformations applied')

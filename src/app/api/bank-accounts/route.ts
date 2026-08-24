import { canAccessBusiness, getSession } from "@/lib/auth";
import { ensureIntegrationSchema } from "@/lib/integrations";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

async function ensureAccountFilterTrigger(): Promise<void> {
  const sql = getSql();
  await sql`
    CREATE OR REPLACE FUNCTION corner_ops_filter_inactive_bank_account()
    RETURNS TRIGGER AS $$
    DECLARE
      account_is_active BOOLEAN;
    BEGIN
      SELECT active INTO account_is_active
      FROM bank_accounts
      WHERE external_account_id = NEW.external_account_id
      LIMIT 1;

      IF account_is_active = FALSE THEN
        NEW.review_status := 'Ignored';
        NEW.user_override := TRUE;
        NEW.classification_source := 'Excluded bank account';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;

}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = businessFrom(new URL(request.url).searchParams.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    await ensureIntegrationSchema();
    await ensureAccountFilterTrigger();
    const rows = await getSql()`
      SELECT
        c.id AS connection_id,
        c.business,
        c.institution_name,
        c.status AS connection_status,
        a.id AS account_id,
        a.external_account_id,
        a.name,
        a.official_name,
        a.mask,
        a.account_type,
        a.account_subtype,
        a.current_balance,
        a.available_balance,
        a.active
      FROM integration_connections c
      JOIN bank_accounts a ON a.connection_id = c.id
      WHERE c.provider = 'Plaid' AND c.business = ${business}
      ORDER BY c.created_at, a.account_type, a.name, a.mask
    ` as unknown as Array<{
      connection_id: string;
      business: Business;
      institution_name: string;
      connection_status: string;
      account_id: string;
      external_account_id: string;
      name: string;
      official_name: string;
      mask: string;
      account_type: string;
      account_subtype: string;
      current_balance: string | number | null;
      available_balance: string | number | null;
      active: boolean;
    }>;

    const connections = Array.from(new Set(rows.map((row) => row.connection_id))).map((connectionId) => {
      const accounts = rows.filter((row) => row.connection_id === connectionId);
      const first = accounts[0];
      return {
        id: connectionId,
        institutionName: first?.institution_name || "Connected institution",
        status: first?.connection_status || "Active",
        accounts: accounts.map((row) => ({
          id: row.account_id,
          externalAccountId: row.external_account_id,
          name: row.name,
          officialName: row.official_name,
          mask: row.mask,
          type: row.account_type,
          subtype: row.account_subtype,
          currentBalance: row.current_balance === null ? null : Number(row.current_balance),
          availableBalance: row.available_balance === null ? null : Number(row.available_balance),
          active: Boolean(row.active),
        })),
      };
    });

    return Response.json({ business, connections });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    if (action !== "select-account" && action !== "set-active-accounts") {
      return Response.json({ error: "Unknown bank account action." }, { status: 400 });
    }

    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const connectionId = String(body.connectionId || "");
    const accountIds = Array.from(new Set(
      action === "select-account"
        ? [String(body.accountId || "")]
        : Array.isArray(body.accountIds) ? body.accountIds.map((value) => String(value || "")) : [],
    )).filter(Boolean);
    if (!connectionId || accountIds.length === 0) {
      return Response.json({ error: "Choose at least one bank or credit-card account to synchronize." }, { status: 400 });
    }

    await ensureIntegrationSchema();
    await ensureAccountFilterTrigger();
    const sql = getSql();
    const accountRows = await sql`
      SELECT a.id, a.external_account_id
      FROM bank_accounts a
      JOIN integration_connections c ON c.id = a.connection_id
      WHERE a.connection_id = ${connectionId}
        AND c.provider = 'Plaid'
        AND c.business = ${business}
      ORDER BY a.name, a.mask
    ` as unknown as Array<{ id: string; external_account_id: string }>;

    if (!accountRows.length) {
      return Response.json({ error: "That Plaid connection was not found for this business." }, { status: 404 });
    }
    const validIds = new Set(accountRows.map((row) => row.id));
    if (accountIds.some((id) => !validIds.has(id))) {
      return Response.json({ error: "One or more selected accounts do not belong to this connection." }, { status: 404 });
    }

    const selectedIds = new Set(accountIds);
    for (const account of accountRows) {
      const active = selectedIds.has(account.id);
      await sql`
        UPDATE bank_accounts
        SET active = ${active}, updated_at = NOW()
        WHERE id = ${account.id}
      `;

      if (active) {
        await sql`
          UPDATE bank_transactions
          SET review_status = CASE WHEN confidence >= 0.9 THEN 'Approved' ELSE 'Needs Review' END,
              user_override = FALSE,
              classification_source = 'Selected account feed',
              updated_at = NOW()
          WHERE connection_id = ${connectionId}
            AND external_account_id = ${account.external_account_id}
            AND classification_source = 'Excluded bank account'
        `;
      } else {
        await sql`
          UPDATE bank_transactions
          SET review_status = 'Ignored',
              user_override = TRUE,
              classification_source = 'Excluded bank account',
              updated_at = NOW()
          WHERE connection_id = ${connectionId}
            AND external_account_id = ${account.external_account_id}
        `;
      }
    }

    return Response.json({ ok: true, connectionId, accountIds, activeCount: accountIds.length });
  } catch (error) {
    return apiError(error);
  }
}
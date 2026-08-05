import { getSql } from "@/lib/db";
import { ensureDirectDepositSchema } from "@/lib/direct-deposit";
import type { Business } from "@/lib/types";

export type DirectDepositAudit = {
  id: string;
  assignedBy: string;
  rescindedBy: string | null;
  rescindedAt: string | null;
  rescindReason: string;
};

type AuditRow = {
  id: string;
  assigned_by: string;
  rescinded_by: string | null;
  rescinded_at: string | Date | null;
  rescind_reason: string;
};

let schemaPromise: Promise<void> | null = null;

export function ensureDirectDepositAdminSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureDirectDepositSchema();
      const sql = getSql();
      await sql`ALTER TABLE direct_deposit_elections ADD COLUMN IF NOT EXISTS rescinded_by TEXT`;
      await sql`ALTER TABLE direct_deposit_elections ADD COLUMN IF NOT EXISTS rescinded_at TIMESTAMPTZ`;
      await sql`ALTER TABLE direct_deposit_elections ADD COLUMN IF NOT EXISTS rescind_reason TEXT NOT NULL DEFAULT ''`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function audit(row: AuditRow): DirectDepositAudit {
  return {
    id: row.id,
    assignedBy: row.assigned_by || "Unknown",
    rescindedBy: row.rescinded_by || null,
    rescindedAt: iso(row.rescinded_at),
    rescindReason: row.rescind_reason || "",
  };
}

export async function listDirectDepositAudit(business: Business): Promise<DirectDepositAudit[]> {
  await ensureDirectDepositAdminSchema();
  const rows = await getSql()`
    SELECT id, assigned_by, rescinded_by, rescinded_at, rescind_reason
    FROM direct_deposit_elections
    WHERE business = ${business}
    ORDER BY assigned_at DESC
  ` as unknown as AuditRow[];
  return rows.map(audit);
}

export async function getDirectDepositAudit(id: string): Promise<DirectDepositAudit | null> {
  await ensureDirectDepositAdminSchema();
  const rows = await getSql()`
    SELECT id, assigned_by, rescinded_by, rescinded_at, rescind_reason
    FROM direct_deposit_elections
    WHERE id = ${id}
    LIMIT 1
  ` as unknown as AuditRow[];
  return rows[0] ? audit(rows[0]) : null;
}

export async function latestDirectDepositAssignmentWasRescinded(input: {
  business: Business;
  employeeId: string;
}): Promise<boolean> {
  await ensureDirectDepositAdminSchema();
  const rows = await getSql()`
    SELECT rescinded_at
    FROM direct_deposit_elections
    WHERE business = ${input.business} AND employee_id = ${input.employeeId}
    ORDER BY assigned_at DESC
    LIMIT 1
  ` as unknown as Array<{ rescinded_at: string | Date | null }>;
  return Boolean(rows[0]?.rescinded_at);
}

export async function rescindDirectDepositElection(input: {
  id: string;
  business: Business;
  actor: string;
  reason?: string;
}): Promise<DirectDepositAudit> {
  await ensureDirectDepositAdminSchema();
  const rows = await getSql()`
    SELECT id, status, signed_at, rescinded_at
    FROM direct_deposit_elections
    WHERE id = ${input.id} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{
    id: string;
    status: string;
    signed_at: string | Date | null;
    rescinded_at: string | Date | null;
  }>;
  const row = rows[0];
  if (!row) throw new Error("Direct-deposit form was not found.");
  if (row.rescinded_at) throw new Error("This direct-deposit form was already rescinded.");
  if (row.status !== "Assigned" || row.signed_at) {
    throw new Error("Only an unsigned assigned direct-deposit form can be rescinded. Signed elections remain preserved.");
  }

  const reason = String(input.reason || "Assigned in error").trim().slice(0, 500) || "Assigned in error";
  const updated = await getSql()`
    UPDATE direct_deposit_elections
    SET status = 'Superseded', rescinded_by = ${input.actor}, rescinded_at = NOW(),
        rescind_reason = ${reason}, updated_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business} AND status = 'Assigned'
    RETURNING id, assigned_by, rescinded_by, rescinded_at, rescind_reason
  ` as unknown as AuditRow[];
  if (!updated[0]) throw new Error("The direct-deposit form changed before it could be rescinded. Reload and try again.");
  return audit(updated[0]);
}

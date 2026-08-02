import { ensureSchema, getSql } from "@/lib/db";
import type { AuditEvent, Business } from "@/lib/types";

type AuditRow = {
  id: string;
  business: Business;
  document_id: string | null;
  action: AuditEvent["action"];
  actor: string;
  details: Record<string, unknown> | string;
  created_at: string | Date;
};

function mapRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    business: row.business,
    documentId: row.document_id,
    action: row.action,
    actor: row.actor,
    details: typeof row.details === "string" ? JSON.parse(row.details) as Record<string, unknown> : row.details,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

export async function recordAuditEvent(input: Omit<AuditEvent, "id" | "createdAt">): Promise<void> {
  await ensureSchema();
  await getSql()`
    INSERT INTO audit_events (id, business, document_id, action, actor, details)
    VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.documentId}, ${input.action},
      ${input.actor}, ${JSON.stringify(input.details)}::jsonb
    )
  `;
}

export async function listAuditEvents(business: Business, limit = 12): Promise<AuditEvent[]> {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const rows = (await getSql()`
    SELECT id, business, document_id, action, actor, details, created_at
    FROM audit_events
    WHERE business = ${business}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as AuditRow[];
  return rows.map(mapRow);
}

from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
def read(p): return (ROOT/p).read_text()
def write(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
    t=read(p); c=t.count(o)
    if c!=1: raise RuntimeError(f'{p}: expected 1 match, got {c}: {o[:120]!r}')
    write(p,t.replace(o,n,1))
def sub(p,pat,n,count=1):
    t=read(p); x,c=re.subn(pat,lambda _m:n,t,count=count,flags=re.S)
    if c!=count: raise RuntimeError(f'{p}: expected {count} regex matches, got {c}: {pat[:120]}')
    write(p,x)

# 409 is a real contract, not a mysterious 500.
rep('src/lib/http.ts','export class RateLimitError extends Error {','export class ConflictError extends Error {\n  constructor(message: string) {\n    super(message);\n    this.name = "ConflictError";\n  }\n}\n\nexport class RateLimitError extends Error {')
rep('src/lib/http.ts','  if (error instanceof ValidationError) {\n    return Response.json({ error: error.message }, { status: 400 });\n  }','  if (error instanceof ValidationError) {\n    return Response.json({ error: error.message }, { status: 400 });\n  }\n  if (error instanceof ConflictError) {\n    return Response.json({ error: error.message }, { status: 409 });\n  }')

# General-purpose audit events retain legacy document fields while supporting every other business entity.
sub('src/lib/types.ts',r'export type AuditEvent = \{.*?\n\};', '''export type AuditEvent = {
  id: string;
  business: Business;
  documentId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
};''')
write('src/lib/audit.ts','''import { ensureSchema, getSql } from "@/lib/db";
import type { AuditEvent, Business } from "@/lib/types";

type AuditRow = {
  id: string;
  business: Business;
  document_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  details: Record<string, unknown> | string;
  created_at: string | Date;
};

function mapRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    business: row.business,
    documentId: row.document_id,
    entityType: row.entity_type || "document",
    entityId: row.entity_id || row.document_id || "",
    action: row.action,
    actor: row.actor,
    details: typeof row.details === "string" ? JSON.parse(row.details) as Record<string, unknown> : row.details,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

export async function recordAuditEvent(input: {
  business: Business;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
  documentId?: string | null;
  entityType?: string;
  entityId?: string;
}): Promise<void> {
  await ensureSchema();
  const documentId = input.documentId || null;
  await getSql()`
    INSERT INTO audit_events (id, business, document_id, entity_type, entity_id, action, actor, details)
    VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${documentId}, ${input.entityType || (documentId ? "document" : "operation")},
      ${input.entityId || documentId || ""}, ${input.action}, ${input.actor}, ${JSON.stringify(input.details || {})}::jsonb
    )
  `;
}

export async function listAuditEvents(business: Business, limit = 12): Promise<AuditEvent[]> {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const rows = (await getSql()`
    SELECT id, business, document_id, entity_type, entity_id, action, actor, details, created_at
    FROM audit_events
    WHERE business = ${business}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `) as AuditRow[];
  return rows.map(mapRow);
}
''')

# Soft-delete messages. Do not destroy the blob or read history; record who removed it.
write('src/lib/message-deletion.ts','''import { recordAuditEvent } from "@/lib/audit";
import { ensureMessageAttachmentSchema } from "@/lib/message-attachments";
import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import type { Business } from "@/lib/types";

function cleanId(value: unknown): string { return String(value || "").trim(); }

export async function deleteOwnerMessage(input: { id: string; business: Business; actor: string; reason?: string }) {
  await ensureMessageAttachmentSchema();
  const id = cleanId(input.id);
  if (!id) throw new Error("Choose a message to delete.");
  const rows = await getSql()`
    UPDATE employee_messages SET deleted_at = NOW(), deleted_by = ${input.actor}, delete_reason = ${String(input.reason || "Owner removed message").slice(0,500)}
    WHERE id = ${id} AND business = ${input.business} AND deleted_at IS NULL
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Message not found or already deleted.");
  await recordAuditEvent({ business: input.business, entityType: "employee_message", entityId: rows[0].id, action: "soft_deleted", actor: input.actor, details: { reason: input.reason || "Owner removed message" } });
  return { id: rows[0].id };
}

export async function deleteEmployeeMessage(session: EmployeeSession, messageId: string) {
  await ensureMessageAttachmentSchema();
  const id = cleanId(messageId);
  if (!id) throw new Error("Choose a message to delete.");
  const rows = await getSql()`
    UPDATE employee_messages SET deleted_at = NOW(), deleted_by = ${session.name}, delete_reason = 'Sender removed message'
    WHERE id = ${id} AND business = ${session.business} AND sender_employee_id = ${session.employeeId} AND deleted_at IS NULL
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("You can only delete messages that you sent.");
  await recordAuditEvent({ business: session.business, entityType: "employee_message", entityId: rows[0].id, action: "soft_deleted", actor: session.name, details: { employeeId: session.employeeId } });
  return { id: rows[0].id };
}
''')
write('src/app/api/messages/delete/route.ts','''import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { deleteOwnerMessage } from "@/lib/message-deletion";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
function readBusiness(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.write");
    const body = await request.json() as { id?: unknown; business?: unknown; reason?: unknown };
    const business = readBusiness(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const deleted = await deleteOwnerMessage({ id: String(body.id || ""), business, actor: session.displayName, reason: String(body.reason || "") });
    return Response.json({ deleted: true, id: deleted.id });
  } catch (error) { return apiError(error); }
}
''')
write('src/app/api/employee/messages/delete/route.ts','''import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import { deleteEmployeeMessage } from "@/lib/message-deletion";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const body = await request.json() as { id?: unknown };
    const deleted = await deleteEmployeeMessage(session, String(body.id || ""));
    return Response.json({ deleted: true, id: deleted.id });
  } catch (error) { return apiError(error); }
}
''')

# Hide soft-deleted messages everywhere employees/managers normally read them.
for path in ['src/app/api/employee/messages/route.ts','src/app/api/employee/messages/status/route.ts','src/app/api/employee/messages/unread/route.ts']:
    t=read(path)
    t=t.replace('WHERE m.business = ${session.business}\n', 'WHERE m.business = ${session.business}\n          AND m.deleted_at IS NULL\n')
    write(path,t)
t=read('src/lib/message-reads.ts')
t=t.replace('WHERE m.sender_employee_id IS NOT NULL\n', 'WHERE m.sender_employee_id IS NOT NULL\n      AND m.deleted_at IS NULL\n')
t=t.replace('WHERE m.business = ${business}\n      AND m.sender_employee_id IS NOT NULL', 'WHERE m.business = ${business}\n      AND m.deleted_at IS NULL\n      AND m.sender_employee_id IS NOT NULL')
t=t.replace('WHERE id = ${messageId}\n      AND business = ${session.business}', 'WHERE id = ${messageId}\n      AND deleted_at IS NULL\n      AND business = ${session.business}')
t=t.replace('WHERE m.business = ${business}\n      ORDER BY m.created_at DESC', 'WHERE m.business = ${business}\n        AND m.deleted_at IS NULL\n      ORDER BY m.created_at DESC')
t=t.replace('WHERE m.business = ${business}\n      ORDER BY r.read_at', 'WHERE m.business = ${business}\n        AND m.deleted_at IS NULL\n      ORDER BY r.read_at')
write('src/lib/message-reads.ts',t)
t=read('src/lib/message-attachments.ts')
t=t.replace('WHERE id = ${messageId}\n      AND business = ${session.business}', 'WHERE id = ${messageId}\n      AND deleted_at IS NULL\n      AND business = ${session.business}')
t=t.replace('WHERE id = ${messageId} AND business = ${business} AND attachment_pathname <>', 'WHERE id = ${messageId} AND business = ${business} AND deleted_at IS NULL AND attachment_pathname <>')
write('src/lib/message-attachments.ts',t)

# SMS is opt-in at the action level too. With no provider configured this stays entirely dormant.
rep('src/lib/staff-notifications.ts','  actor: string;\n}) {\n  await ensureStaffNotificationSchema();\n  const body = clean(input.body, 3000);','  actor: string;\n  sendSms?: boolean;\n}) {\n  await ensureStaffNotificationSchema();\n  const body = clean(input.body, 3000);')
old='''  const sms = await deliverSms({
    recipients,
    text: () => [
      `${input.business}: ${body}`,
      hubUrl ? `Open Employee Hub: ${hubUrl}` : "",
      "Reply STOP to opt out.",
    ].filter(Boolean).join(" "),
  });'''
new='''  const sms = input.sendSms === true
    ? await deliverSms({
        recipients,
        text: () => [
          `${input.business}: ${body}`,
          hubUrl ? `Open Employee Hub: ${hubUrl}` : "",
          "Reply STOP to opt out.",
        ].filter(Boolean).join(" "),
      })
    : { provider: "disabled" as const, configured: false, requested: false, sent: 0, failed: 0, missingPhone: 0, notOptedIn: recipients.filter((employee) => !employee.smsOptIn).length, skipped: recipients.length, failures: [], accepted: [] };'''
rep('src/lib/staff-notifications.ts',old,new)
rep('src/app/api/workforce/route.ts','        actor: session.displayName,\n      }));','        actor: session.displayName,\n        sendSms: body.sendSms === true,\n      }));')
# Telnyx webhook is self-authenticated by its signature. It remains inert without a configured public key.
rep('src/proxy.ts','  "/api/square/webhook",\n','  "/api/square/webhook",\n  "/api/telnyx/inbound",\n')

# Card transfer matcher: prevent reuse of an already-claimed card transaction and survive a race/23505.
rep('src/lib/expense-control.ts','import { getSql } from "@/lib/db";\n','import { getSql } from "@/lib/db";\nimport { recordAuditEvent } from "@/lib/audit";\nimport { ConflictError } from "@/lib/http";\n')
rep('src/lib/expense-control.ts','    const bankPayments = rows.filter((row) => row.account_type !== "credit" && numberValue(row.signed_amount) < 0);\n    const cardCredits = rows.filter((row) => row.account_type === "credit" && numberValue(row.signed_amount) > 0);','    const claimedRows = await getSql()`SELECT bank_transaction_id, card_transaction_id FROM credit_card_transfer_matches WHERE business = ${activeBusiness} AND status <> \'Ignored\'` as unknown as Array<{ bank_transaction_id: string; card_transaction_id: string }>;\n    const claimedBankIds = new Set(claimedRows.map((row) => row.bank_transaction_id));\n    const claimedCardIds = new Set(claimedRows.map((row) => row.card_transaction_id));\n    const bankPayments = rows.filter((row) => row.account_type !== "credit" && numberValue(row.signed_amount) < 0 && !claimedBankIds.has(row.id));\n    const cardCredits = rows.filter((row) => row.account_type === "credit" && numberValue(row.signed_amount) > 0 && !claimedCardIds.has(row.id));')
rep('src/lib/expense-control.ts','      const inserted = await getSql()`\n        INSERT INTO credit_card_transfer_matches (','      if (claimedCardIds.has(best.card.id) || claimedBankIds.has(bank.id)) continue;\n      let inserted: Array<{ id: string; status: string }> = [];\n      try {\n        inserted = await getSql()`\n        INSERT INTO credit_card_transfer_matches (')
rep('src/lib/expense-control.ts','      ` as unknown as Array<{ id: string; status: string }>;\n      if (!inserted[0]) continue;\n      suggested += inserted[0].status === "Suggested" ? 1 : 0;','      ` as unknown as Array<{ id: string; status: string }>;\n      } catch (error) {\n        if (String((error as { code?: string }).code || "") === "23505") continue;\n        throw error;\n      }\n      if (!inserted[0]) continue;\n      claimedBankIds.add(bank.id);\n      claimedCardIds.add(best.card.id);\n      suggested += inserted[0].status === "Suggested" ? 1 : 0;')
# Transfer-match audit.
rep('src/lib/expense-control.ts','  await getSql()`\n    UPDATE credit_card_transfer_matches SET\n      status = \'Matched\', matched_by = ${clean(actor, 255)}, matched_at = NOW(), updated_at = NOW()\n    WHERE id = ${id}\n  `;\n}','  await getSql()`\n    UPDATE credit_card_transfer_matches SET\n      status = \'Matched\', matched_by = ${clean(actor, 255)}, matched_at = NOW(), updated_at = NOW()\n    WHERE id = ${id}\n  `;\n  const businessRows = await getSql()`SELECT business FROM credit_card_transfer_matches WHERE id = ${id} LIMIT 1` as unknown as Array<{ business: Business }>;\n  if (businessRows[0]) await recordAuditEvent({ business: businessRows[0].business, entityType: "credit_card_transfer_match", entityId: id, action: "matched", actor, details: { bankTransactionId: match.bank_transaction_id, cardTransactionId: match.card_transaction_id } });\n}')

# OCR and matching are separate failure domains. A matching outage must never turn successful OCR into Failed.
sub('src/lib/expense-control.ts',r'  if \(!documentAiConfigured\(\)\) return \{ id, status: "Needs Configuration" \};\n  try \{(.*?)    await refreshReceiptMatches\(input.business\);\n    return \{ id, status: "Processed", \.\.\.parsed \};\n  \} catch \(error\) \{(.*?)    return \{ id, status: "Failed", error: message \};\n  \}', '''  if (!documentAiConfigured()) return { id, status: "Needs Configuration" };
  let parsed;
  try {\1    parsed = parsed;
  } catch (error) {\2    return { id, status: "Failed", error: message };
  }
  try {
    await refreshReceiptMatches(input.business);
    return { id, status: "Processed", ...parsed };
  } catch (error) {
    const matchError = error instanceof Error ? error.message : String(error);
    console.error("[expense-control] receipt OCR succeeded but match refresh failed", error);
    return { id, status: "Processed", ...parsed, matchError };
  }''')
# The generic regex above intentionally reuses the original parsed declaration; normalize the accidental self assignment if present.
t=read('src/lib/expense-control.ts').replace('    parsed = parsed;\n','')
write('src/lib/expense-control.ts',t)

# Confirming a second receipt for an already-matched bank transaction becomes a clear 409.
rep('src/lib/expense-control.ts','  if (!rows[0]) throw new Error("Receipt match was not found.");\n  await getSql()`','  if (!rows[0]) throw new Error("Receipt match was not found.");\n  if (input.accept) {\n    const conflict = await getSql()`\n      SELECT other.id FROM receipt_transaction_matches target\n      JOIN receipt_transaction_matches other ON other.bank_transaction_id = target.bank_transaction_id AND other.status = \'Matched\' AND other.id <> target.id\n      WHERE target.id = ${input.id} AND target.business = ${input.business} LIMIT 1\n    ` as unknown as Array<{ id: string }>;\n    if (conflict[0]) throw new ConflictError("That bank transaction is already matched to another receipt.");\n  }\n  await getSql()`')
rep('src/lib/expense-control.ts','  `;\n  return { id: input.id, status: input.accept ? "Matched" : "Ignored" };\n}\n\nasync function driveFilesInFolder','  `;\n  await recordAuditEvent({ business: input.business, entityType: "receipt_match", entityId: input.id, action: input.accept ? "matched" : "ignored", actor: input.actor });\n  return { id: input.id, status: input.accept ? "Matched" : "Ignored" };\n}\n\nasync function driveFilesInFolder')

# Google Drive identity is the file id. modifiedTime describes a version; it is not identity.
rep('src/lib/expense-control.ts','    const sourceKey = `drive:${file.id}:${file.modifiedTime || "unknown"}`;\n    const existing = await getSql()`\n      SELECT id FROM receipt_documents WHERE source_key = ${sourceKey} LIMIT 1\n    ` as unknown as Array<{ id: string }>;\n    if (existing[0]) {\n      unchanged += 1;\n      continue;\n    }','    const sourceKey = `drive:${file.id}`;\n    const existing = await getSql()`\n      SELECT id, modified_at_source FROM receipt_documents WHERE source_key = ${sourceKey} LIMIT 1\n    ` as unknown as Array<{ id: string; modified_at_source: string | null }>;\n    if (existing[0] && String(existing[0].modified_at_source || "") === String(file.modifiedTime || "")) {\n      unchanged += 1;\n      continue;\n    }')

# Card statement matching gets an actor and audit record.
rep('src/lib/card-statements.ts','import { getSql } from "@/lib/db";\n','import { getSql } from "@/lib/db";\nimport { recordAuditEvent } from "@/lib/audit";\n')
rep('src/lib/card-statements.ts','  bankTransactionId: string;\n}) {','  bankTransactionId: string;\n  actor: string;\n}) {')
rep('src/lib/card-statements.ts','  `;\n  return { matched: true };\n}\n\nexport async function findCardStatementFile','  `;\n  await recordAuditEvent({ business: input.business, entityType: "credit_card_statement", entityId: input.statementId, action: "payment_matched", actor: input.actor, details: { bankTransactionId: input.bankTransactionId } });\n  return { matched: true };\n}\n\nexport async function findCardStatementFile')
rep('src/app/api/card-statements/route.ts','      bankTransactionId: String(body.bankTransactionId || ""),\n    }));','      bankTransactionId: String(body.bankTransactionId || ""),\n      actor: session.email,\n    }));')

# Vendor bill state and inventory quantity mutations get an actor and audit event.
rep('src/lib/finance-operations-actions.ts','import { getSql } from "@/lib/db";\n','import { getSql } from "@/lib/db";\nimport { recordAuditEvent } from "@/lib/audit";\n')
rep('src/lib/finance-operations-actions.ts','  bankTransactionId?: string | null;\n}) {','  bankTransactionId?: string | null;\n  actor: string;\n}) {')
rep('src/lib/finance-operations-actions.ts','  `;\n  return { updated: true, status: input.status };\n}\n\nexport async function createInventoryItem','  `;\n  await recordAuditEvent({ business: input.business, entityType: "vendor_bill", entityId: input.billId, action: `status_${input.status.toLowerCase()}`, actor: input.actor, details: { priorStatus: bill.status, bankTransactionId } });\n  return { updated: true, status: input.status };\n}\n\nexport async function createInventoryItem')
rep('src/lib/finance-operations-actions.ts','  currentQuantity: number;\n}) {','  currentQuantity: number;\n  actor: string;\n}) {')
rep('src/lib/finance-operations-actions.ts','  if (!rows[0]) throw new Error("Inventory item was not found.");\n  return { id: rows[0].id, name: rows[0].name, currentQuantity: Number(rows[0].current_quantity) };','  if (!rows[0]) throw new Error("Inventory item was not found.");\n  await recordAuditEvent({ business: input.business, entityType: "inventory_item", entityId: rows[0].id, action: "quantity_adjusted", actor: input.actor, details: { currentQuantity: Number(rows[0].current_quantity) } });\n  return { id: rows[0].id, name: rows[0].name, currentQuantity: Number(rows[0].current_quantity) };')
rep('src/app/api/finance-operations/route.ts','        bankTransactionId: clean(body.bankTransactionId, 80) || null,\n      }));','        bankTransactionId: clean(body.bankTransactionId, 80) || null,\n        actor: session.email,\n      }));')
rep('src/app/api/finance-operations/route.ts','        currentQuantity: numeric(body.currentQuantity),\n      }));','        currentQuantity: numeric(body.currentQuantity),\n        actor: session.email,\n      }));')

print('Stage 4 compliance/audit transformations applied')
import { recordAuditEvent } from "@/lib/audit";
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

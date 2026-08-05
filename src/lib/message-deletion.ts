import { ensureMessageAttachmentSchema } from "@/lib/message-attachments";
import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import type { Business } from "@/lib/types";

type DeletedMessage = {
  id: string;
  attachment_url: string;
};

function cleanId(value: unknown): string {
  return String(value || "").trim();
}

export async function deleteOwnerMessage(input: { id: string; business: Business }) {
  await ensureMessageAttachmentSchema();
  const id = cleanId(input.id);
  if (!id) throw new Error("Choose a message to delete.");

  const rows = await getSql()`
    DELETE FROM employee_messages
    WHERE id = ${id} AND business = ${input.business}
    RETURNING id, attachment_url
  ` as unknown as DeletedMessage[];

  if (!rows[0]) throw new Error("Message not found.");
  return {
    id: rows[0].id,
    attachmentUrl: String(rows[0].attachment_url || ""),
  };
}

export async function deleteEmployeeMessage(session: EmployeeSession, messageId: string) {
  await ensureMessageAttachmentSchema();
  const id = cleanId(messageId);
  if (!id) throw new Error("Choose a message to delete.");

  const rows = await getSql()`
    DELETE FROM employee_messages
    WHERE id = ${id}
      AND business = ${session.business}
      AND sender_employee_id = ${session.employeeId}
    RETURNING id, attachment_url
  ` as unknown as DeletedMessage[];

  if (!rows[0]) throw new Error("You can only delete messages that you sent.");
  return {
    id: rows[0].id,
    attachmentUrl: String(rows[0].attachment_url || ""),
  };
}

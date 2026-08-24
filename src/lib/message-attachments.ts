import { ensureWorkforceSchema } from "@/lib/workforce";
import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import type { Business } from "@/lib/types";

let messageAttachmentSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

export function ensureMessageAttachmentSchema(): Promise<void> {
  if (!messageAttachmentSchemaPromise) {
    messageAttachmentSchemaPromise = (async () => {
      await ensureWorkforceSchema();
      const sql = getSql();
      await sql`ALTER TABLE employee_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employee_messages ADD COLUMN IF NOT EXISTS attachment_pathname TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employee_messages ADD COLUMN IF NOT EXISTS attachment_name TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employee_messages ADD COLUMN IF NOT EXISTS attachment_type TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employee_messages ADD COLUMN IF NOT EXISTS attachment_size BIGINT NOT NULL DEFAULT 0`;
    })().catch((error) => {
      messageAttachmentSchemaPromise = null;
      throw error;
    });
  }
  return messageAttachmentSchemaPromise;
}

async function activeEmployee(employeeId: string, business: Business) {
  const rows = await getSql()`
    SELECT id, name
    FROM employees
    WHERE id = ${employeeId} AND business = ${business} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{ id: string; name: string }>;
  if (!rows[0]) throw new Error("Employee is not active for this location.");
  return rows[0];
}

export async function sendEmployeePhotoMessage(session: EmployeeSession, input: {
  recipientEmployeeId?: string | null;
  body?: string;
  attachmentUrl: string;
  attachmentPathname: string;
  attachmentName: string;
  attachmentType: string;
  attachmentSize: number;
}) {
  await ensureMessageAttachmentSchema();
  const employee = await activeEmployee(session.employeeId, session.business);
  if (input.recipientEmployeeId) await activeEmployee(input.recipientEmployeeId, session.business);
  const body = clean(input.body, 3000) || "Photo attached.";
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO employee_messages (
      id, business, sender_employee_id, sender_name, recipient_employee_id, message_type, body,
      attachment_url, attachment_pathname, attachment_name, attachment_type, attachment_size
    ) VALUES (
      ${id}, ${session.business}, ${session.employeeId}, ${employee.name},
      ${input.recipientEmployeeId || null}, ${input.recipientEmployeeId ? "Direct" : "Team"}, ${body},
      ${clean(input.attachmentUrl, 1000)}, ${clean(input.attachmentPathname, 1000)},
      ${clean(input.attachmentName, 255)}, ${clean(input.attachmentType, 120)},
      ${Math.max(0, Math.round(input.attachmentSize))}
    )
  `;
  return { sent: true, id };
}

type MessageAttachment = {
  pathname: string;
  fileName: string;
  contentType: string;
  size: number;
};

function mapAttachment(row: Record<string, unknown>): MessageAttachment {
  return {
    pathname: String(row.attachment_pathname || ""),
    fileName: String(row.attachment_name || "photo"),
    contentType: String(row.attachment_type || "application/octet-stream"),
    size: Number(row.attachment_size || 0),
  };
}

export async function employeeMessageAttachment(session: EmployeeSession, messageId: string): Promise<MessageAttachment | null> {
  await ensureMessageAttachmentSchema();
  const rows = await getSql()`
    SELECT attachment_pathname, attachment_name, attachment_type, attachment_size
    FROM employee_messages
    WHERE id = ${messageId}
      AND deleted_at IS NULL
      AND business = ${session.business}
      AND attachment_pathname <> ''
      AND (
        message_type IN ('Team', 'Announcement')
        OR sender_employee_id = ${session.employeeId}
        OR recipient_employee_id = ${session.employeeId}
      )
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapAttachment(rows[0]) : null;
}

export async function ownerMessageAttachment(business: Business, messageId: string): Promise<MessageAttachment | null> {
  await ensureMessageAttachmentSchema();
  const rows = await getSql()`
    SELECT attachment_pathname, attachment_name, attachment_type, attachment_size
    FROM employee_messages
    WHERE id = ${messageId} AND business = ${business} AND deleted_at IS NULL AND attachment_pathname <> ''
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapAttachment(rows[0]) : null;
}

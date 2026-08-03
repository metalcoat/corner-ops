import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import type { Business } from "@/lib/types";
import { ensureMessageAttachmentSchema } from "@/lib/message-attachments";

let readSchemaPromise: Promise<void> | null = null;

export function ensureMessageReadSchema(): Promise<void> {
  if (!readSchemaPromise) {
    readSchemaPromise = (async () => {
      await ensureMessageAttachmentSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS employee_message_reads (
          message_id UUID NOT NULL REFERENCES employee_messages(id) ON DELETE CASCADE,
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (message_id, employee_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employee_message_reads_employee_idx ON employee_message_reads (employee_id, read_at DESC)`;
    })().catch((error) => {
      readSchemaPromise = null;
      throw error;
    });
  }
  return readSchemaPromise;
}

export async function markEmployeeMessageSeen(session: EmployeeSession, messageId: string) {
  await ensureMessageReadSchema();
  const rows = await getSql()`
    SELECT id, sender_employee_id
    FROM employee_messages
    WHERE id = ${messageId}
      AND business = ${session.business}
      AND (
        message_type IN ('Team', 'Announcement')
        OR sender_employee_id = ${session.employeeId}
        OR recipient_employee_id = ${session.employeeId}
      )
    LIMIT 1
  ` as unknown as Array<{ id: string; sender_employee_id: string | null }>;
  const message = rows[0];
  if (!message) throw new Error("Message was not found or is not visible to this employee.");
  if (message.sender_employee_id === session.employeeId) return { seen: false, ownMessage: true };

  const inserted = await getSql()`
    INSERT INTO employee_message_reads (message_id, employee_id)
    VALUES (${messageId}, ${session.employeeId})
    ON CONFLICT (message_id, employee_id) DO NOTHING
    RETURNING read_at
  ` as unknown as Array<{ read_at: string }>;
  return { seen: true, firstSeen: inserted[0]?.read_at || null };
}

type AdminMessageRow = {
  id: string;
  business: Business;
  sender_employee_id: string | null;
  sender_name: string;
  recipient_employee_id: string | null;
  recipient_name: string | null;
  message_type: string;
  body: string;
  attachment_name: string;
  attachment_type: string;
  attachment_size: string | number;
  created_at: string;
};

export async function adminMessagesDashboard(business: Business) {
  await ensureMessageReadSchema();
  const sql = getSql();
  const [employees, messages, reads] = await Promise.all([
    sql`
      SELECT id, name, position, active
      FROM employees
      WHERE business = ${business} AND active = TRUE
      ORDER BY name
    `,
    sql`
      SELECT m.id, m.business, m.sender_employee_id, m.sender_name,
        m.recipient_employee_id, recipient.name AS recipient_name,
        m.message_type, m.body, m.attachment_name, m.attachment_type,
        m.attachment_size, m.created_at
      FROM employee_messages m
      LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
      WHERE m.business = ${business}
      ORDER BY m.created_at DESC
      LIMIT 250
    `,
    sql`
      SELECT r.message_id, r.employee_id, r.read_at, e.name
      FROM employee_message_reads r
      JOIN employee_messages m ON m.id = r.message_id
      JOIN employees e ON e.id = r.employee_id
      WHERE m.business = ${business}
      ORDER BY r.read_at
    `,
  ]);

  const activeEmployees = employees as unknown as Array<{ id: string; name: string; position: string; active: boolean }>;
  const readRows = reads as unknown as Array<{ message_id: string; employee_id: string; read_at: string; name: string }>;
  const readMap = new Map<string, typeof readRows>();
  for (const row of readRows) {
    const list = readMap.get(row.message_id) || [];
    list.push(row);
    readMap.set(row.message_id, list);
  }

  return {
    business,
    employees: activeEmployees,
    messages: (messages as unknown as AdminMessageRow[]).map((message) => {
      const expected = message.recipient_employee_id
        ? activeEmployees.filter((employee) => employee.id === message.recipient_employee_id)
        : activeEmployees.filter((employee) => employee.id !== message.sender_employee_id);
      const expectedIds = new Set(expected.map((employee) => employee.id));
      const seenBy = (readMap.get(message.id) || [])
        .filter((read) => expectedIds.has(read.employee_id))
        .map((read) => ({ employeeId: read.employee_id, name: read.name, readAt: read.read_at }));
      const seenIds = new Set(seenBy.map((read) => read.employeeId));
      return {
        ...message,
        attachment_size: Number(message.attachment_size || 0),
        expectedCount: expected.length,
        seenCount: seenBy.length,
        seenBy,
        unseenNames: expected.filter((employee) => !seenIds.has(employee.id)).map((employee) => employee.name),
      };
    }),
  };
}

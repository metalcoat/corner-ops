import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import { ensureEmployeeProfileSchema, scheduleColorFromId } from "@/lib/employee-profile";
import type { Business } from "@/lib/types";
import { ensureMessageAttachmentSchema } from "@/lib/message-attachments";

let readSchemaPromise: Promise<void> | null = null;
const MESSAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ensureMessageReadSchema(): Promise<void> {
  if (!readSchemaPromise) {
    readSchemaPromise = (async () => {
      await Promise.all([ensureMessageAttachmentSchema(), ensureEmployeeProfileSchema()]);
      const sql = getSql();
    })().catch((error) => {
      readSchemaPromise = null;
      throw error;
    });
  }
  return readSchemaPromise;
}

function normalizedReaderEmail(value: string): string {
  return String(value || "").trim().toLowerCase();
}

async function notificationStart(readerEmail: string): Promise<string> {
  const email = normalizedReaderEmail(readerEmail);
  if (!email) throw new Error("A signed-in manager is required for message notifications.");
  const inserted = await getSql()`
    INSERT INTO owner_message_notification_state (reader_email)
    VALUES (${email})
    ON CONFLICT (reader_email) DO NOTHING
    RETURNING started_at
  ` as unknown as Array<{ started_at: string }>;
  if (inserted[0]?.started_at) return inserted[0].started_at;
  const rows = await getSql()`
    SELECT started_at
    FROM owner_message_notification_state
    WHERE reader_email = ${email}
    LIMIT 1
  ` as unknown as Array<{ started_at: string }>;
  return rows[0]?.started_at || new Date().toISOString();
}

export async function adminUnreadMessageSummary(readerEmail: string, businesses: Business[]) {
  await ensureMessageReadSchema();
  const email = normalizedReaderEmail(readerEmail);
  const startedAt = await notificationStart(email);
  const canReadDeli = businesses.includes("Corner Deli");
  const canReadTiki = businesses.includes("Tiki");
  const rows = await getSql()`
    SELECT m.business, COUNT(*)::INTEGER AS unread_count
    FROM employee_messages m
    WHERE m.sender_employee_id IS NOT NULL
      AND m.deleted_at IS NULL
      AND m.created_at >= ${startedAt}
      AND (
        (m.business = 'Corner Deli' AND ${canReadDeli})
        OR (m.business = 'Tiki' AND ${canReadTiki})
      )
      AND NOT EXISTS (
        SELECT 1
        FROM owner_message_reads r
        WHERE r.message_id = m.id AND r.reader_email = ${email}
      )
    GROUP BY m.business
  ` as unknown as Array<{ business: Business; unread_count: string | number }>;
  const byBusiness: Record<Business, number> = { "Corner Deli": 0, Tiki: 0 };
  for (const row of rows) byBusiness[row.business] = Number(row.unread_count || 0);
  return {
    messages: byBusiness["Corner Deli"] + byBusiness.Tiki,
    byBusiness,
  };
}

export async function adminUnreadMessageIds(readerEmail: string, business: Business): Promise<string[]> {
  await ensureMessageReadSchema();
  const email = normalizedReaderEmail(readerEmail);
  const startedAt = await notificationStart(email);
  const rows = await getSql()`
    SELECT m.id::text AS id
    FROM employee_messages m
    WHERE m.business = ${business}
      AND m.sender_employee_id IS NOT NULL
      AND m.deleted_at IS NULL
      AND m.created_at >= ${startedAt}
      AND NOT EXISTS (
        SELECT 1
        FROM owner_message_reads r
        WHERE r.message_id = m.id AND r.reader_email = ${email}
      )
    ORDER BY m.created_at, m.id
    LIMIT 1000
  ` as unknown as Array<{ id: string }>;
  return rows.map((row) => String(row.id));
}

export async function markAdminConversationMessageSeen(
  readerEmail: string,
  business: Business,
  messageId: unknown,
) {
  await ensureMessageReadSchema();
  const email = normalizedReaderEmail(readerEmail);
  const id = String(messageId || "").trim().toLowerCase();
  if (!MESSAGE_UUID_PATTERN.test(id)) throw new Error("Message selection is invalid.");
  const startedAt = await notificationStart(email);
  const visible = await getSql()`
    SELECT id
    FROM employee_messages
    WHERE id = ${id}::uuid
      AND business = ${business}
      AND sender_employee_id IS NOT NULL
      AND deleted_at IS NULL
      AND created_at >= ${startedAt}
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!visible[0]) throw new Error("Message was not found or is not visible to management.");
  const inserted = await getSql()`
    INSERT INTO owner_message_reads (message_id, reader_email)
    VALUES (${id}::uuid, ${email})
    ON CONFLICT (message_id, reader_email) DO NOTHING
    RETURNING read_at
  ` as unknown as Array<{ read_at: string }>;
  return { seen: true, firstSeen: inserted[0]?.read_at || null };
}

export async function markAdminMessagesRead(readerEmail: string, business: Business) {
  await ensureMessageReadSchema();
  const email = normalizedReaderEmail(readerEmail);
  const startedAt = await notificationStart(email);
  const rows = await getSql()`
    INSERT INTO owner_message_reads (message_id, reader_email)
    SELECT m.id, ${email}
    FROM employee_messages m
    WHERE m.business = ${business}
      AND m.deleted_at IS NULL
      AND m.sender_employee_id IS NOT NULL
      AND m.created_at >= ${startedAt}
    ON CONFLICT (message_id, reader_email) DO NOTHING
    RETURNING message_id
  ` as unknown as Array<{ message_id: string }>;
  return { markedRead: rows.length };
}

export async function markEmployeeMessageSeen(session: EmployeeSession, messageId: string) {
  await ensureMessageReadSchema();
  const rows = await getSql()`
    SELECT id, sender_employee_id
    FROM employee_messages
    WHERE id = ${messageId}
      AND deleted_at IS NULL
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
  sender_chat_nickname: string;
  sender_schedule_color: string;
  sender_avatar_set: boolean;
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
      SELECT id, name, position, active, schedule_color,
        (profile_photo_pathname <> '') AS avatar_set
      FROM employees
      WHERE business = ${business} AND active = TRUE
      ORDER BY name
    `,
    sql`
      SELECT m.id, m.business, m.sender_employee_id, m.sender_name,
        COALESCE(sender.chat_nickname, '') AS sender_chat_nickname,
        COALESCE(sender.schedule_color, '#64748B') AS sender_schedule_color,
        COALESCE(sender.profile_photo_pathname <> '', FALSE) AS sender_avatar_set,
        m.recipient_employee_id, recipient.name AS recipient_name,
        m.message_type, m.body, m.attachment_name, m.attachment_type,
        m.attachment_size, m.created_at
      FROM employee_messages m
      LEFT JOIN employees sender ON sender.id = m.sender_employee_id
      LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
      WHERE m.business = ${business}
        AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT 250
    `,
    sql`
      SELECT r.message_id, r.employee_id, r.read_at, e.name
      FROM employee_message_reads r
      JOIN employee_messages m ON m.id = r.message_id
      JOIN employees e ON e.id = r.employee_id
      WHERE m.business = ${business}
        AND m.deleted_at IS NULL
      ORDER BY r.read_at
    `,
  ]);

  const activeEmployees = (employees as unknown as Array<Record<string, unknown>>).map((employee) => ({
    id: String(employee.id),
    name: String(employee.name),
    position: String(employee.position || ""),
    active: Boolean(employee.active),
    scheduleColor: String(employee.schedule_color || scheduleColorFromId(String(employee.id))),
    avatarSet: Boolean(employee.avatar_set),
  }));
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

import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import { scheduleColorFromId } from "@/lib/employee-profile";
import type { Business } from "@/lib/types";

export const TEAM_CONVERSATION_KEY = "team";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ConversationKind = "team" | "owner" | "direct";
type ConversationDescriptor = {
  key: string;
  kind: ConversationKind;
  employeeIds: string[];
};

type AttachmentInput = {
  url: string;
  pathname: string;
  name: string;
  type: string;
  size: number;
};

type ActiveEmployee = {
  id: string;
  name: string;
  position: string;
  schedule_color?: string;
  profile_photo_pathname?: string;
  chat_nickname?: string;
};

type MessageRow = {
  id: string;
  business: Business;
  conversation_key: string;
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
  attachment_size: number | string;
  created_at: string;
};

type ReceiptRow = {
  message_id: string;
  employee_id: string;
  name: string;
  read_at?: string | null;
};

type DecoratedMessage = MessageRow & {
  conversationKey: string;
  attachment_size: number;
  expectedCount: number;
  seenCount: number;
  seenBy: Array<{ employeeId: string; name: string; readAt: string }>;
  unseenNames: string[];
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function uuid(value: unknown, label = "Employee"): string {
  const result = clean(value, 80);
  if (!UUID_PATTERN.test(result)) throw new Error(`${label} selection is invalid.`);
  return result.toLowerCase();
}

export function ownerConversationKey(employeeId: string): string {
  return `owner:${uuid(employeeId)}`;
}

export function directConversationKey(firstEmployeeId: string, secondEmployeeId: string): string {
  const ids = [uuid(firstEmployeeId), uuid(secondEmployeeId)].sort();
  if (ids[0] === ids[1]) throw new Error("Choose another employee for a direct conversation.");
  return `direct:${ids[0]}:${ids[1]}`;
}

function parseConversationKey(value: unknown): ConversationDescriptor {
  const key = clean(value, 180).toLowerCase();
  if (!key || key === TEAM_CONVERSATION_KEY) {
    return { key: TEAM_CONVERSATION_KEY, kind: "team", employeeIds: [] };
  }
  const ownerMatch = key.match(/^owner:([0-9a-f-]{36})$/i);
  if (ownerMatch) {
    const employeeId = uuid(ownerMatch[1]);
    return { key: `owner:${employeeId}`, kind: "owner", employeeIds: [employeeId] };
  }
  const directMatch = key.match(/^direct:([0-9a-f-]{36}):([0-9a-f-]{36})$/i);
  if (directMatch) {
    const normalized = directConversationKey(directMatch[1], directMatch[2]);
    return { key: normalized, kind: "direct", employeeIds: normalized.split(":").slice(1) };
  }
  throw new Error("Choose a valid message conversation.");
}

export function conversationParticipantIds(value: unknown): string[] {
  try {
    return parseConversationKey(value).employeeIds;
  } catch {
    return [];
  }
}

export function conversationIsVisibleToActiveRoster(
  value: unknown,
  activeEmployeeIds: Iterable<string>,
  viewerEmployeeId?: string | null,
): boolean {
  let descriptor: ConversationDescriptor;
  try {
    descriptor = parseConversationKey(value);
  } catch {
    return false;
  }
  const active = new Set(Array.from(activeEmployeeIds, (id) => String(id).toLowerCase()));
  const viewer = viewerEmployeeId ? String(viewerEmployeeId).toLowerCase() : null;

  if (descriptor.kind === "team") return true;
  if (descriptor.employeeIds.some((id) => !active.has(id))) return false;
  if (!viewer) return true;
  if (descriptor.kind === "owner") return descriptor.employeeIds[0] === viewer;
  return descriptor.employeeIds.includes(viewer);
}

async function activeEmployees(business: Business, employeeIds?: string[]): Promise<ActiveEmployee[]> {
  if (employeeIds?.length) {
    const rows = await getSql()`
      SELECT id, name, position, schedule_color, profile_photo_pathname, chat_nickname
      FROM employees
      WHERE business = ${business}
        AND active = TRUE
        AND id IN (
          SELECT value::uuid
          FROM jsonb_array_elements_text(${JSON.stringify(employeeIds)}::jsonb)
        )
      ORDER BY name
    ` as unknown as ActiveEmployee[];
    if (rows.length !== new Set(employeeIds).size) {
      throw new Error("One or more conversation participants are archived or no longer active at this location.");
    }
    return rows;
  }
  return await getSql()`
    SELECT id, name, position, schedule_color, profile_photo_pathname, chat_nickname
    FROM employees
    WHERE business = ${business} AND active = TRUE
    ORDER BY name
  ` as unknown as ActiveEmployee[];
}

async function resolveConversation(input: {
  business: Business;
  conversationKey?: unknown;
  senderEmployeeId?: string | null;
}): Promise<{ descriptor: ConversationDescriptor; members: ActiveEmployee[]; recipientEmployeeId: string | null }> {
  const descriptor = parseConversationKey(input.conversationKey);
  const senderEmployeeId = input.senderEmployeeId ? uuid(input.senderEmployeeId, "Sender") : null;
  const members = descriptor.kind === "team"
    ? await activeEmployees(input.business)
    : await activeEmployees(input.business, descriptor.employeeIds);

  if (!members.length) throw new Error("This conversation has no active employee recipients.");
  const memberIds = new Set(members.map((member) => String(member.id).toLowerCase()));
  if (senderEmployeeId) {
    if (descriptor.kind === "owner" && descriptor.employeeIds[0] !== senderEmployeeId) {
      throw new Error("Employees can only use their own management conversation.");
    }
    if (descriptor.kind === "direct" && !memberIds.has(senderEmployeeId)) {
      throw new Error("You are not a participant in this employee conversation.");
    }
    if (descriptor.kind === "team" && !memberIds.has(senderEmployeeId)) {
      throw new Error("Employee is not active for this location.");
    }
  }

  let recipientEmployeeId: string | null = null;
  if (descriptor.kind === "owner") {
    recipientEmployeeId = senderEmployeeId ? null : descriptor.employeeIds[0];
  } else if (descriptor.kind === "direct" && senderEmployeeId) {
    recipientEmployeeId = descriptor.employeeIds.find((id) => id !== senderEmployeeId) || null;
  }

  return { descriptor, members, recipientEmployeeId };
}

export async function sendConversationMessage(input: {
  business: Business;
  conversationKey?: unknown;
  senderEmployeeId?: string | null;
  senderName: string;
  body?: unknown;
  attachment?: AttachmentInput | null;
}) {
  const senderEmployeeId = input.senderEmployeeId ? uuid(input.senderEmployeeId, "Sender") : null;
  const { descriptor, members, recipientEmployeeId } = await resolveConversation({
    business: input.business,
    conversationKey: input.conversationKey,
    senderEmployeeId,
  });
  const messageBody = clean(input.body, 3000) || (input.attachment ? "Photo attached." : "");
  if (!messageBody && !input.attachment) throw new Error("Type a message or attach a photo.");

  const id = crypto.randomUUID();
  const memberIds = Array.from(new Set(members.map((member) => String(member.id).toLowerCase())));
  const attachment = input.attachment || null;
  const senderUuid = senderEmployeeId || "";
  const recipientUuid = recipientEmployeeId || "";
  const rows = await getSql()`
    WITH inserted AS (
      INSERT INTO employee_messages (
        id, business, conversation_key, sender_employee_id, sender_name,
        recipient_employee_id, message_type, body,
        attachment_url, attachment_pathname, attachment_name, attachment_type, attachment_size
      ) VALUES (
        ${id}::uuid, ${input.business}, ${descriptor.key}, NULLIF(${senderUuid}::text, '')::uuid,
        ${clean(input.senderName, 160)}, NULLIF(${recipientUuid}::text, '')::uuid,
        'Conversation', ${messageBody},
        ${clean(attachment?.url, 1000)}, ${clean(attachment?.pathname, 1000)},
        ${clean(attachment?.name, 255)}, ${clean(attachment?.type, 120)},
        ${Math.max(0, Math.round(Number(attachment?.size || 0)))}
      )
      RETURNING *
    ), snapshotted AS (
      INSERT INTO employee_message_recipients (message_id, employee_id)
      SELECT inserted.id, participant.value::uuid
      FROM inserted
      CROSS JOIN jsonb_array_elements_text(${JSON.stringify(memberIds)}::jsonb) AS participant(value)
      ON CONFLICT (message_id, employee_id) DO NOTHING
      RETURNING employee_id
    )
    SELECT inserted.*,
      (SELECT COUNT(*)::integer FROM snapshotted) AS recipient_count
    FROM inserted
  ` as unknown as Array<Record<string, unknown>>;
  const saved = rows[0];
  if (!saved) throw new Error("The message was not saved.");
  if (Number(saved.recipient_count || 0) !== memberIds.length) {
    throw new Error("The message recipient list could not be saved completely.");
  }

  return {
    sent: true,
    id,
    conversationKey: descriptor.key,
    conversationKind: descriptor.kind,
    recipientEmployeeId,
    recipientEmployeeIds: memberIds,
    pushRecipientEmployeeIds: memberIds.filter((employeeId) => employeeId !== senderEmployeeId),
    notifyOwnersOnly: descriptor.kind === "owner" && Boolean(senderEmployeeId),
  };
}

function receiptMaps(recipientRows: ReceiptRow[], readRows: ReceiptRow[]) {
  const recipients = new Map<string, ReceiptRow[]>();
  const reads = new Map<string, ReceiptRow[]>();
  for (const row of recipientRows) {
    const list = recipients.get(row.message_id) || [];
    list.push(row);
    recipients.set(row.message_id, list);
  }
  for (const row of readRows) {
    const list = reads.get(row.message_id) || [];
    list.push(row);
    reads.set(row.message_id, list);
  }
  return { recipients, reads };
}

function decorateMessages(messages: MessageRow[], recipientRows: ReceiptRow[], readRows: ReceiptRow[]): DecoratedMessage[] {
  const maps = receiptMaps(recipientRows, readRows);
  return messages.map((message) => {
    const expected = (maps.recipients.get(message.id) || [])
      .filter((recipient) => recipient.employee_id !== message.sender_employee_id);
    const expectedIds = new Set(expected.map((recipient) => recipient.employee_id));
    const seenBy = (maps.reads.get(message.id) || [])
      .filter((read) => expectedIds.has(read.employee_id))
      .map((read) => ({ employeeId: read.employee_id, name: read.name, readAt: String(read.read_at || "") }));
    const seenIds = new Set(seenBy.map((read) => read.employeeId));
    return {
      ...message,
      conversationKey: message.conversation_key,
      attachment_size: Number(message.attachment_size || 0),
      expectedCount: expected.length,
      seenCount: seenBy.length,
      seenBy,
      unseenNames: expected.filter((recipient) => !seenIds.has(recipient.employee_id)).map((recipient) => recipient.name),
    };
  });
}

function visibleMessages(
  messages: DecoratedMessage[],
  activeEmployeeIds: Iterable<string>,
  viewerEmployeeId?: string | null,
): DecoratedMessage[] {
  return messages.filter((message) => conversationIsVisibleToActiveRoster(
    message.conversationKey,
    activeEmployeeIds,
    viewerEmployeeId,
  ));
}

async function recentMessageRows(business: Business, employeeId?: string | null): Promise<MessageRow[]> {
  if (employeeId) {
    return await getSql()`
      SELECT m.id, m.business, m.conversation_key, m.sender_employee_id, m.sender_name,
        COALESCE(sender.chat_nickname, '') AS sender_chat_nickname,
        COALESCE(sender.schedule_color, '#64748B') AS sender_schedule_color,
        COALESCE(sender.profile_photo_pathname <> '', FALSE) AS sender_avatar_set,
        m.recipient_employee_id, recipient.name AS recipient_name,
        m.message_type, m.body, m.attachment_name, m.attachment_type,
        m.attachment_size, m.created_at
      FROM employee_messages m
      JOIN employee_message_recipients visible
        ON visible.message_id = m.id AND visible.employee_id = ${employeeId}::uuid
      LEFT JOIN employees sender ON sender.id = m.sender_employee_id
      LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
      WHERE m.business = ${business} AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 500
    ` as unknown as MessageRow[];
  }
  return await getSql()`
    SELECT m.id, m.business, m.conversation_key, m.sender_employee_id, m.sender_name,
      COALESCE(sender.chat_nickname, '') AS sender_chat_nickname,
      COALESCE(sender.schedule_color, '#64748B') AS sender_schedule_color,
      COALESCE(sender.profile_photo_pathname <> '', FALSE) AS sender_avatar_set,
      m.recipient_employee_id, recipient.name AS recipient_name,
      m.message_type, m.body, m.attachment_name, m.attachment_type,
      m.attachment_size, m.created_at
    FROM employee_messages m
    LEFT JOIN employees sender ON sender.id = m.sender_employee_id
    LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
    WHERE m.business = ${business} AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 700
  ` as unknown as MessageRow[];
}

async function receiptRows(business: Business, employeeId?: string | null) {
  const visibility = employeeId
    ? await getSql()`
        SELECT mr.message_id, mr.employee_id, e.name
        FROM employee_message_recipients mr
        JOIN employee_messages m ON m.id = mr.message_id
        JOIN employees e ON e.id = mr.employee_id AND e.active = TRUE
        WHERE m.business = ${business} AND m.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM employee_message_recipients own
            WHERE own.message_id = m.id AND own.employee_id = ${employeeId}::uuid
          )
        ORDER BY m.created_at DESC
        LIMIT 6000
      `
    : await getSql()`
        SELECT mr.message_id, mr.employee_id, e.name
        FROM employee_message_recipients mr
        JOIN employee_messages m ON m.id = mr.message_id
        JOIN employees e ON e.id = mr.employee_id AND e.active = TRUE
        WHERE m.business = ${business} AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 9000
      `;
  const reads = employeeId
    ? await getSql()`
        SELECT r.message_id, r.employee_id, e.name, r.read_at
        FROM employee_message_reads r
        JOIN employee_messages m ON m.id = r.message_id
        JOIN employees e ON e.id = r.employee_id AND e.active = TRUE
        WHERE m.business = ${business} AND m.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM employee_message_recipients own
            WHERE own.message_id = m.id AND own.employee_id = ${employeeId}::uuid
          )
        ORDER BY r.read_at
        LIMIT 6000
      `
    : await getSql()`
        SELECT r.message_id, r.employee_id, e.name, r.read_at
        FROM employee_message_reads r
        JOIN employee_messages m ON m.id = r.message_id
        JOIN employees e ON e.id = r.employee_id AND e.active = TRUE
        WHERE m.business = ${business} AND m.deleted_at IS NULL
        ORDER BY r.read_at
        LIMIT 9000
      `;
  return {
    recipients: visibility as unknown as ReceiptRow[],
    reads: reads as unknown as ReceiptRow[],
  };
}

function mapEmployee(item: ActiveEmployee) {
  return {
    id: String(item.id),
    name: String(item.name),
    position: String(item.position || ""),
    active: true,
    scheduleColor: String(item.schedule_color || scheduleColorFromId(String(item.id))),
    avatarSet: Boolean(item.profile_photo_pathname),
    chatNickname: String(item.chat_nickname || ""),
  };
}

function unreadMessageIdsForViewer(messages: DecoratedMessage[], reads: ReceiptRow[], viewerEmployeeId: string): string[] {
  const readKeys = new Set(reads
    .filter((read) => read.employee_id.toLowerCase() === viewerEmployeeId.toLowerCase())
    .map((read) => read.message_id));
  return messages
    .filter((message) => message.sender_employee_id?.toLowerCase() !== viewerEmployeeId.toLowerCase() && !readKeys.has(message.id))
    .map((message) => message.id);
}

export async function ownerConversationDashboard(business: Business, viewAsEmployeeId?: unknown) {
  const employees = await activeEmployees(business);
  const activeIds = employees.map((employee) => String(employee.id).toLowerCase());
  const requestedViewer = clean(viewAsEmployeeId, 80);
  const viewerId = requestedViewer ? uuid(requestedViewer, "Employee") : null;
  const viewer = viewerId
    ? employees.find((employee) => String(employee.id).toLowerCase() === viewerId)
    : null;
  if (viewerId && !viewer) throw new Error("That employee is archived or no longer active at this location.");

  const [messages, receipts] = await Promise.all([
    recentMessageRows(business, viewerId),
    receiptRows(business, viewerId),
  ]);
  const decorated = visibleMessages(
    decorateMessages(messages, receipts.recipients, receipts.reads),
    activeIds,
    viewerId,
  );

  return {
    business,
    employees: employees.map(mapEmployee),
    messages: decorated,
    unreadMessageIds: viewerId ? unreadMessageIdsForViewer(decorated, receipts.reads, viewerId) : [],
    viewAsEmployee: viewer ? mapEmployee(viewer) : null,
  };
}

export async function employeeConversationDashboard(session: EmployeeSession) {
  const employees = await activeEmployees(session.business);
  const employee = employees.find((item) => String(item.id).toLowerCase() === session.employeeId.toLowerCase());
  if (!employee) throw new Error("Employee is archived or no longer active for this location.");
  const [messages, receipts] = await Promise.all([
    recentMessageRows(session.business, session.employeeId),
    receiptRows(session.business, session.employeeId),
  ]);
  const activeIds = employees.map((item) => String(item.id).toLowerCase());
  const decorated = visibleMessages(
    decorateMessages(messages, receipts.recipients, receipts.reads),
    activeIds,
    session.employeeId,
  );

  return {
    employee: mapEmployee(employee),
    directory: employees.map(mapEmployee),
    messages: decorated,
    unreadMessageIds: unreadMessageIdsForViewer(decorated, receipts.reads, session.employeeId),
  };
}

export async function markConversationMessageSeen(session: EmployeeSession, messageId: unknown) {
  const id = uuid(messageId, "Message");
  const rows = await getSql()`
    SELECT m.id, m.sender_employee_id
    FROM employee_messages m
    JOIN employee_message_recipients recipient
      ON recipient.message_id = m.id AND recipient.employee_id = ${session.employeeId}::uuid
    WHERE m.id = ${id}::uuid
      AND m.business = ${session.business}
      AND m.deleted_at IS NULL
    LIMIT 1
  ` as unknown as Array<{ id: string; sender_employee_id: string | null }>;
  const message = rows[0];
  if (!message) throw new Error("Message was not found or is not visible to this employee.");
  if (message.sender_employee_id === session.employeeId) return { seen: false, ownMessage: true };
  const inserted = await getSql()`
    INSERT INTO employee_message_reads (message_id, employee_id)
    VALUES (${id}::uuid, ${session.employeeId}::uuid)
    ON CONFLICT (message_id, employee_id) DO NOTHING
    RETURNING read_at
  ` as unknown as Array<{ read_at: string }>;
  return { seen: true, firstSeen: inserted[0]?.read_at || null };
}

type ConversationAttachment = {
  pathname: string;
  fileName: string;
  contentType: string;
  size: number;
};

function attachment(row: Record<string, unknown> | undefined): ConversationAttachment | null {
  if (!row?.attachment_pathname) return null;
  return {
    pathname: String(row.attachment_pathname),
    fileName: String(row.attachment_name || "photo"),
    contentType: String(row.attachment_type || "application/octet-stream"),
    size: Number(row.attachment_size || 0),
  };
}

export async function ownerConversationAttachment(business: Business, messageId: unknown) {
  const id = uuid(messageId, "Message");
  const rows = await getSql()`
    SELECT attachment_pathname, attachment_name, attachment_type, attachment_size
    FROM employee_messages
    WHERE id = ${id}::uuid AND business = ${business}
      AND deleted_at IS NULL AND attachment_pathname <> ''
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  return attachment(rows[0]);
}

export async function employeeConversationAttachment(session: EmployeeSession, messageId: unknown) {
  const id = uuid(messageId, "Message");
  const rows = await getSql()`
    SELECT m.attachment_pathname, m.attachment_name, m.attachment_type, m.attachment_size
    FROM employee_messages m
    JOIN employee_message_recipients recipient
      ON recipient.message_id = m.id AND recipient.employee_id = ${session.employeeId}::uuid
    WHERE m.id = ${id}::uuid AND m.business = ${session.business}
      AND m.deleted_at IS NULL AND m.attachment_pathname <> ''
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  return attachment(rows[0]);
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("message migration snapshots recipients and excludes later employees from old team messages", () => {
  const migration = source("db/migrations/0009_message_conversations.sql");
  assert.match(migration, /ADD COLUMN conversation_key text/);
  assert.match(migration, /CREATE TABLE public\.employee_message_recipients/);
  assert.match(migration, /e\.created_at <= m\.created_at/);
  assert.match(migration, /ON CONFLICT \(message_id, employee_id\) DO NOTHING/);
  assert.match(migration, /employee_messages_message_type_check/);
  assert.match(migration, /'Conversation'::text/);
  assert.match(migration, /SET message_type = 'Conversation'/);
});

test("conversation sends atomically save a typed message and exact recipient snapshot", () => {
  const conversations = source("src/lib/message-conversations.ts");
  assert.match(conversations, /WITH inserted AS \(/);
  assert.match(conversations, /NULLIF\(\$\{senderUuid\}::text, ''\)::uuid/);
  assert.match(conversations, /NULLIF\(\$\{recipientUuid\}::text, ''\)::uuid/);
  assert.match(conversations, /INSERT INTO employee_message_recipients/);
  assert.match(conversations, /jsonb_array_elements_text/);
  assert.match(conversations, /recipient_count/);
  assert.match(conversations, /recipient list could not be saved completely/);
});

test("archived employees disappear from normal inboxes and receipts", () => {
  const conversations = source("src/lib/message-conversations.ts");
  assert.match(conversations, /conversationIsVisibleToActiveRoster/);
  assert.match(conversations, /archived or no longer active/);
  assert.match(conversations, /JOIN employees e ON e\.id = mr\.employee_id AND e\.active = TRUE/);
  assert.match(conversations, /visibleMessages\(/);
});

test("management messaging keeps read-only impersonation while linking only Chris reply paths", () => {
  const owner = source("src/app/ops/messages/page.tsx");
  const employee = source("src/app/employee/conversation-messages-dock.tsx");
  const route = source("src/app/api/message-conversations/route.ts");
  const conversations = source("src/lib/message-conversations.ts");
  assert.match(owner, /Entire team/);
  assert.match(owner, /View as/);
  assert.match(owner, /Read-only impersonation/);
  assert.match(owner, /messageConversationRow/);
  assert.match(owner, /Employee-to-employee · View only/);
  assert.match(owner, /Chris conversation · Management can reply/);
  assert.match(route, /viewAsEmployeeId/);
  assert.match(route, /linkedMessageEmployeeIdForOwner/);
  assert.doesNotMatch(route, /Employee-to-employee conversations are view-only for management/);
  assert.match(employee, /linkedManagementAccess/);
  assert.match(employee, /Management conversation · reply as Chris/);
  assert.match(conversations, /LINKED_OWNER_USER_ID/);
  assert.match(conversations, /LINKED_CHRIS_EMPLOYEE_ID/);
  assert.match(conversations, /Management can only reply to employee conversations involving Chris/);
});

test("employees use a dedicated full-page inbox instead of a global message dock", () => {
  const layout = source("src/app/employee/layout.tsx");
  const page = source("src/app/employee/messages/page.tsx");
  const employee = source("src/app/employee/conversation-messages-dock.tsx");
  const redirect = source("src/app/employee/message-notification-redirect.tsx");
  assert.match(layout, /href="\/employee\/messages"/);
  assert.doesNotMatch(layout, /<EmployeeMessagesDock/);
  assert.match(page, /EmployeeMessagesApp/);
  assert.match(employee, /Entire team/);
  assert.match(employee, /Management/);
  assert.match(employee, /messageConversationRow/);
  assert.match(employee, /message-seen/);
  assert.match(redirect, /location\.hash === "#messages"/);
  assert.match(redirect, /location\.replace\("\/employee\/messages"\)/);
});

test("production migration runner expands the legacy message-type constraint before converting messages", () => {
  const runner = source("db/migrations/0010_release_compatibility.sql");
  assert.match(runner, /allow conversation message type/);
  assert.match(runner, /DROP CONSTRAINT IF EXISTS employee_messages_message_type_check/);
  assert.match(runner, /'Conversation'::text/);
  assert.match(runner, /retire dynamic team visibility/);
});

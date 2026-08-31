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
  assert.match(migration, /SET message_type = 'Conversation'/);
});

test("new conversation messages atomically save their recipient snapshot", () => {
  const conversations = source("src/lib/message-conversations.ts");
  assert.match(conversations, /WITH inserted AS \(/);
  assert.match(conversations, /INSERT INTO employee_messages/);
  assert.match(conversations, /INSERT INTO employee_message_recipients/);
  assert.match(conversations, /jsonb_array_elements_text/);
  assert.match(conversations, /JOIN employee_message_recipients visible/);
  assert.match(conversations, /markConversationMessageSeen/);
});

test("owner and employee messaging use stable inline conversation channels", () => {
  const owner = source("src/app/ops/messages/page.tsx");
  const employee = source("src/app/employee/conversation-messages-dock.tsx");
  assert.match(owner, /Person or group/);
  assert.match(owner, /Whole team/);
  assert.match(owner, /Reply in \{selectedConversation\.label\}/);
  assert.match(owner, /Seen by \$\{message\.seenCount\} of \$\{message\.expectedCount\}/);
  assert.match(employee, /label: "Management"/);
  assert.match(employee, /label: "Whole team"/);
  assert.match(employee, /conversationKey/);
  assert.match(employee, /employeeConversationReceipt/);
});

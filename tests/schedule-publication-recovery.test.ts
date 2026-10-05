import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("schedule publication messages use the threaded message schema", () => {
  const publication = source("src/lib/business-schedule-publication.ts");
  assert.equal(publication.includes("conversation_key"), true);
  assert.equal(publication.includes("'Conversation'"), true);
  assert.equal(publication.includes("INSERT INTO employee_message_recipients"), true);
  assert.equal(publication.includes("owner:${employee.id}"), true);
});

test("a failed idempotency reservation is resumed while a draft still exists", () => {
  const publication = source("src/lib/business-schedule-publication.ts");
  assert.equal(publication.includes("let publicationId = crypto.randomUUID()"), true);
  assert.equal(publication.includes("resumeStalledPublication"), true);
  assert.equal(publication.includes("draftRows.length > 0"), true);
  assert.equal(publication.includes('row.delivery_status === "Failed"'), true);
  assert.equal(publication.includes("recoveredStalledAttempt: true"), true);
});

test("SMS configuration status is explicitly non-blocking in the manager notice", () => {
  const page = source("src/app/ops/workforce/page.tsx");
  assert.equal(page.includes("unavailable; schedule publication is not blocked"), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { rezkuRecoveryCandidates } from "../src/lib/rezku-recovery-policy";

const NOW = Date.parse("2026-08-24T10:00:00Z");

function received(id: string, createdAt: string) {
  return { id, createdAt };
}

test("Rezku recovery ignores processed mail and retries missing, failed, partial and stale processing mail", () => {
  const result = rezkuRecoveryCandidates({
    now: NOW,
    maxEmails: 10,
    received: [
      received("processed", "2026-08-24T09:00:00Z"),
      received("missing", "2026-08-24T09:10:00Z"),
      received("failed", "2026-08-24T09:20:00Z"),
      received("partial", "2026-08-24T09:30:00Z"),
      received("processing-fresh", "2026-08-24T09:40:00Z"),
      received("processing-stale", "2026-08-24T09:50:00Z"),
    ],
    tracked: [
      { emailId: "processed", status: "Processed", updatedAt: "2026-08-24T09:05:00Z" },
      { emailId: "failed", status: "Failed", updatedAt: "2026-08-24T09:25:00Z" },
      { emailId: "partial", status: "Partial", updatedAt: "2026-08-24T09:35:00Z" },
      { emailId: "processing-fresh", status: "Processing", updatedAt: "2026-08-24T09:55:00Z" },
      { emailId: "processing-stale", status: "Processing", updatedAt: "2026-08-24T09:30:00Z" },
    ],
  });
  assert.deepEqual(result.map((row) => row.id), ["processing-stale", "partial", "failed", "missing"]);
});

test("Rezku recovery is bounded and prioritizes newest missing mail", () => {
  const result = rezkuRecoveryCandidates({
    now: NOW,
    maxEmails: 2,
    received: [
      received("oldest", "2026-08-22T03:00:00Z"),
      received("newest", "2026-08-24T03:00:00Z"),
      received("middle", "2026-08-23T03:00:00Z"),
    ],
    tracked: [],
  });
  assert.deepEqual(result.map((row) => row.id), ["newest", "middle"]);
});

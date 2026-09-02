import assert from "node:assert/strict";
import test from "node:test";
import { schedulePublicationIdempotencyKey, scheduleStateHash } from "../src/lib/schedule-publication-key";

const shifts = [
  { id: "b", employeeId: "2", position: "Cook", startsAt: "2026-08-24T16:00:00Z", endsAt: "2026-08-24T22:00:00Z" },
  { id: "a", employeeId: "1", position: "Counter", startsAt: "2026-08-24T12:00:00Z", endsAt: "2026-08-24T18:00:00Z" },
];

test("schedule state hash is stable regardless of row order", () => {
  assert.equal(scheduleStateHash(shifts), scheduleStateHash([...shifts].reverse()));
});

test("same publish state produces the same idempotency key", () => {
  const stateHash = scheduleStateHash(shifts);
  const first = schedulePublicationIdempotencyKey({ business: "Corner Deli", weekStart: "2026-08-24", previousPublicationId: null, stateHash, mode: "initial" });
  const second = schedulePublicationIdempotencyKey({ business: "Corner Deli", weekStart: "2026-08-24", previousPublicationId: null, stateHash, mode: "initial" });
  assert.equal(first, second);
});

test("a later explicit resend gets a new key after the previous publication changes", () => {
  const stateHash = scheduleStateHash(shifts);
  const first = schedulePublicationIdempotencyKey({ business: "Tiki", weekStart: "2026-08-24", previousPublicationId: "pub-1", stateHash, mode: "resend" });
  const later = schedulePublicationIdempotencyKey({ business: "Tiki", weekStart: "2026-08-24", previousPublicationId: "pub-2", stateHash, mode: "resend" });
  assert.notEqual(first, later);
});

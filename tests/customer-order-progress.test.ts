import assert from "node:assert/strict";
import test from "node:test";
import { waitingForOpening } from "../src/lib/customer-order-progress.js";

const order = { status: "sent_to_kitchen", timing_mode: "asap", promised_at: "2026-11-09T16:00:00Z", quoted_lead_max_minutes: 30 };

test("an ASAP preorder waits for its opening, then moves to preparation", () => {
  assert.equal(waitingForOpening(order, new Date("2026-11-09T03:30:00Z")), true);
  assert.equal(waitingForOpening(order, new Date("2026-11-09T15:29:59Z")), true);
  assert.equal(waitingForOpening(order, new Date("2026-11-09T15:30:00Z")), false);
});

test("ordinary ASAP and delayed pickups never wait for a later store opening", () => {
  assert.equal(waitingForOpening(order, new Date("2026-11-09T15:31:00Z")), false);
  assert.equal(waitingForOpening(order, new Date("2026-11-10T03:30:00Z")), false);
});

test("actual kitchen progress and scheduled orders override ASAP inference", () => {
  for (const status of ["in_progress", "ready", "completed", "cancelled", "draft"])
    assert.equal(waitingForOpening({ ...order, status }, new Date("2026-11-09T03:30:00Z")), false);
  assert.equal(waitingForOpening({ ...order, timing_mode: "future" }, new Date("2026-11-09T03:30:00Z")), false);
});

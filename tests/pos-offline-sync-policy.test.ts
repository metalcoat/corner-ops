import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOfflineSyncStatus,
  createOnlineAlertState,
  offlineOrderAlreadySubmitted,
  readIdempotencyKey,
  reconcileOnlineAlerts,
  singleFlight,
} from "../src/lib/pos-offline-sync-policy.js";

test("offline sync retries transient failures and parks business conflicts", () => {
  assert.equal(classifyOfflineSyncStatus(200), "synced");
  assert.equal(classifyOfflineSyncStatus(201), "synced");
  for (const status of [500, 502, 503, 504, 401, 403, 408, 429]) assert.equal(classifyOfflineSyncStatus(status), "retry", String(status));
  for (const status of [400, 404, 409, 422]) assert.equal(classifyOfflineSyncStatus(status), "conflict", String(status));
});

test("orders past draft count as already submitted, cancelled or draft do not", () => {
  for (const status of ["sent_to_kitchen", "in_progress", "ready", "completed"]) assert.equal(offlineOrderAlreadySubmitted(status), true);
  for (const status of ["draft", "confirmed", "cancelled", "", null, undefined]) assert.equal(offlineOrderAlreadySubmitted(status), false);
});

test("idempotency keys accept client UUIDs only", () => {
  assert.equal(readIdempotencyKey("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(readIdempotencyKey(" 3f2504e0-4f89-41d3-9a0c-0305e82c3301 "), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  for (const value of [undefined, null, "", "abc", 42, "3f2504e0-4f89-41d3-9a0c-0305e82c33011", "'; DROP TABLE x; --"]) assert.equal(readIdempotencyKey(value), null);
});

test("first alert poll is a silent baseline, later new orders stay pending until they leave the queue", () => {
  const state = createOnlineAlertState();
  assert.deepEqual(reconcileOnlineAlerts(state, ["a", "b"]), []);
  assert.equal(state.pending.size, 0);
  assert.deepEqual(reconcileOnlineAlerts(state, ["a", "b", "c"]), ["c"]);
  assert.deepEqual([...state.pending], ["c"]);
  // Still waiting on the next poll: not fresh again, but still pending (keeps re-chiming).
  assert.deepEqual(reconcileOnlineAlerts(state, ["a", "b", "c"]), []);
  assert.deepEqual([...state.pending], ["c"]);
  // Kitchen started it: it leaves the waiting list and no longer needs an alert.
  assert.deepEqual(reconcileOnlineAlerts(state, ["a", "b"]), []);
  assert.equal(state.pending.size, 0);
});

test("acknowledged orders do not re-alert while they remain waiting", () => {
  const state = createOnlineAlertState();
  reconcileOnlineAlerts(state, []);
  assert.deepEqual(reconcileOnlineAlerts(state, ["x"]), ["x"]);
  state.pending.clear();
  assert.deepEqual(reconcileOnlineAlerts(state, ["x"]), []);
  assert.equal(state.pending.size, 0);
});

test("singleFlight skips ticks while a request is in flight", async () => {
  let calls = 0;
  let release!: () => void;
  const poll = singleFlight(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return calls;
  });
  const first = poll();
  assert.equal(await poll(), undefined);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 1);
  const second = poll();
  release();
  assert.equal(await second, 2);
});

test("singleFlight releases after a failure", async () => {
  let fail = true;
  const poll = singleFlight(async () => { if (fail) throw new Error("down"); return "ok"; });
  await assert.rejects(poll());
  fail = false;
  assert.equal(await poll(), "ok");
});

import assert from "node:assert/strict";
import test from "node:test";
import { matchWalkInsToOrders, parseDoorChimeEvent, summarizeWalkIns } from "../src/lib/door-chime-policy";

const at = (minutes: number, seconds = 0) => new Date(Date.UTC(2026, 9, 17, 16, minutes, seconds)).toISOString();
const order = (id: string, minutes: number, seconds = 0) => ({ id, displayNumber: id, createdAt: at(minutes, seconds) });

test("door chime: detector bodies are validated", () => {
  assert.deepEqual(parseDoorChimeEvent({}), { business: "Corner Deli", camera: "entrance", kind: "person" });
  assert.deepEqual(parseDoorChimeEvent({ business: "Tiki", camera: "front door", kind: "line_crossing" }), { business: "Tiki", camera: "front door", kind: "line_crossing" });
  assert.throws(() => parseDoorChimeEvent({ business: "Elsewhere" }), /Unknown business/);
  assert.throws(() => parseDoorChimeEvent({ kind: "car" }), /Kind must be/);
  assert.throws(() => parseDoorChimeEvent({ camera: "<script>" }), /Camera names/);
});

test("door chime: orders go to the oldest waiting walk-in", () => {
  const matched = matchWalkInsToOrders(
    [{ id: 1, detectedAt: at(0) }, { id: 2, detectedAt: at(1) }, { id: 3, detectedAt: at(30) }, { id: 4, detectedAt: at(50) }],
    // Each order takes the oldest walk-in still waiting; walk-in 3 never gets one.
    [order("A", 0, 0), order("B", 2), order("C", 3, 30), order("D", 55)],
    at(58),
  );
  assert.deepEqual(matched.map((walkIn) => [walkIn.id, walkIn.status, walkIn.order?.id ?? null, walkIn.waitSeconds]), [
    [1, "served", "A", 0],
    [2, "served", "B", 60],
    [3, "missed", null, null],
    [4, "served", "D", 300],
  ]);
});

test("door chime: walk-ins past ten minutes are missed, not matched to a later order", () => {
  const matched = matchWalkInsToOrders([{ id: 1, detectedAt: at(0) }, { id: 2, detectedAt: at(9) }], [order("A", 12)], at(13));
  assert.deepEqual(matched.map((walkIn) => [walkIn.id, walkIn.status, walkIn.waitSeconds]), [[1, "missed", null], [2, "served", 180]]);
  const waiting = matchWalkInsToOrders([{ id: 5, detectedAt: at(0) }], [], at(4));
  assert.equal(waiting[0].status, "waiting");
});

test("door chime: dashboard summary", () => {
  const matched = matchWalkInsToOrders(
    [{ id: 1, detectedAt: at(0) }, { id: 2, detectedAt: at(1) }, { id: 3, detectedAt: at(2) }, { id: 4, detectedAt: at(40) }],
    [order("A", 0, 10), order("B", 1, 30), order("C", 5, 20)],
    at(55),
  );
  const summary = summarizeWalkIns(matched, (iso) => new Date(iso).getUTCMinutes() < 30 ? 12 : 13);
  assert.deepEqual(summary, {
    walkIns: 4, served: 3, missed: 1, waiting: 0, averageSeconds: 80, medianSeconds: 30, longestSeconds: 200,
    byHour: [{ hour: 12, count: 3 }, { hour: 13, count: 1 }],
  });
  assert.equal(summarizeWalkIns([], () => 0).averageSeconds, null);
});

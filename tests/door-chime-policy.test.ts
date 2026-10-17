import assert from "node:assert/strict";
import test from "node:test";
import { createDoorChimeState, dueGreetReminders, parseDoorChimeEvent, parseDoorGreet, reconcileDoorEvents, summarizeDoorGreets } from "../src/lib/door-chime-policy";

test("door chime: first poll is a baseline, later polls return only new walk-ins", () => {
  const state = createDoorChimeState();
  assert.deepEqual(reconcileDoorEvents(state, [4, 5]), []);
  assert.deepEqual(reconcileDoorEvents(state, [4, 5]), []);
  assert.deepEqual(reconcileDoorEvents(state, [5, 7, 6]), [6, 7]);
  // Events age out of the recent window; that never re-rings or rewinds.
  assert.deepEqual(reconcileDoorEvents(state, []), []);
  assert.deepEqual(reconcileDoorEvents(state, [7]), []);
  assert.deepEqual(reconcileDoorEvents(state, [8]), [8]);
});

test("door chime: an empty first poll still sets the baseline", () => {
  const state = createDoorChimeState();
  assert.deepEqual(reconcileDoorEvents(state, []), []);
  assert.deepEqual(reconcileDoorEvents(state, [1]), [1]);
});

test("door chime: detector bodies are validated", () => {
  assert.deepEqual(parseDoorChimeEvent({}), { business: "Corner Deli", camera: "entrance", kind: "person" });
  assert.deepEqual(parseDoorChimeEvent({ business: "Tiki", camera: "front door", kind: "line_crossing" }), { business: "Tiki", camera: "front door", kind: "line_crossing" });
  assert.throws(() => parseDoorChimeEvent({ business: "Elsewhere" }), /Unknown business/);
  assert.throws(() => parseDoorChimeEvent({ kind: "car" }), /Kind must be/);
  assert.throws(() => parseDoorChimeEvent({ camera: "<script>" }), /Camera names/);
});

test("door chime: ungreeted walk-ins re-chime once at each reminder age", () => {
  const rung = new Map<number, number>();
  assert.deepEqual(dueGreetReminders(rung, [{ id: 1, ageSeconds: 5 }]), []);
  assert.deepEqual(dueGreetReminders(rung, [{ id: 1, ageSeconds: 31 }]), [1]);
  assert.deepEqual(dueGreetReminders(rung, [{ id: 1, ageSeconds: 34 }]), []);
  assert.deepEqual(dueGreetReminders(rung, [{ id: 1, ageSeconds: 61 }, { id: 2, ageSeconds: 2 }]), [1]);
  assert.deepEqual(dueGreetReminders(rung, [{ id: 1, ageSeconds: 500 }]), [1]);
  assert.deepEqual(dueGreetReminders(rung, [{ id: 1, ageSeconds: 530 }]), []);
  // Greeted: forgotten.
  assert.deepEqual(dueGreetReminders(rung, []), []);
  assert.equal(rung.size, 0);
});

test("door chime: greet taps are validated", () => {
  assert.deepEqual(parseDoorGreet({ ids: [3, "3", 4] }), { ids: [3, 4], outcome: "greeted" });
  assert.deepEqual(parseDoorGreet({ ids: [5], outcome: "not_customer" }), { ids: [5], outcome: "not_customer" });
  assert.throws(() => parseDoorGreet({ ids: [] }), /Choose/);
  assert.throws(() => parseDoorGreet({ ids: [1], outcome: "ignored" }), /Outcome/);
});

test("door chime: dashboard summary of time to greet", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 17, 16, 0, seconds)).toISOString();
  const summary = summarizeDoorGreets([
    { detectedAt: at(0), greetedAt: at(10), outcome: "greeted", ageSeconds: 900 },
    { detectedAt: at(0), greetedAt: at(30), outcome: "greeted", ageSeconds: 900 },
    { detectedAt: at(0), greetedAt: at(200), outcome: "greeted", ageSeconds: 900 },
    { detectedAt: at(0), greetedAt: at(5), outcome: "not_customer", ageSeconds: 900 },
    { detectedAt: at(0), greetedAt: null, outcome: null, ageSeconds: 300 },
    { detectedAt: at(0), greetedAt: null, outcome: null, ageSeconds: 20 },
  ]);
  assert.deepEqual(summary, { walkIns: 5, greeted: 3, waiting: 1, missed: 2, notCustomer: 1, averageSeconds: 80, medianSeconds: 30, longestSeconds: 200 });
  assert.equal(summarizeDoorGreets([]).averageSeconds, null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createDoorChimeState, parseDoorChimeEvent, reconcileDoorEvents } from "../src/lib/door-chime-policy";

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

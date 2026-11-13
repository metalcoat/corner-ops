import assert from "node:assert/strict";
import test from "node:test";
import { overtimeScheduleHint } from "../src/lib/schedule-overtime-hint";

const shift = (id: string, day: number, hours: number, position: string) => ({ id, startsAt: `2026-11-0${2 + day}T15:00:00Z`, endsAt: `2026-11-0${2 + day}T23:00:00Z`, position, hours });

test("overtime on an in-store shift with driving earlier in the week: suggest moving driving last", () => {
  const hint = overtimeScheduleHint([shift("a", 0, 8, "Delivery"), shift("b", 1, 9, "Pizza"), shift("c", 2, 9, "Pizza"), shift("d", 3, 9, "Pizza"), shift("e", 4, 9, "Fryer")]);
  assert.deepEqual(hint.overtimeShifts.map((s) => [s.id, s.overtimeHours, s.driving]), [["e", 4, false]]);
  assert.equal(hint.inStoreOvertimeHours, 4);
  assert.match(hint.suggestion, /driving shift is last/);
});

test("overtime already on driving: no suggestion", () => {
  const hint = overtimeScheduleHint([shift("b", 0, 9, "Pizza"), shift("c", 1, 9, "Pizza"), shift("d", 2, 9, "Pizza"), shift("e", 3, 9, "Pizza"), shift("a", 4, 8, "Delivery")]);
  assert.deepEqual(hint.overtimeShifts.map((s) => [s.id, s.overtimeHours, s.driving]), [["a", 4, true]]);
  assert.equal(hint.suggestion, "");
});

test("no driving shifts at all: suggest making the last shift Delivery if they can drive", () => {
  const hint = overtimeScheduleHint([0, 1, 2, 3, 4].map((d) => shift(`s${d}`, d, 9, "Pizza")));
  assert.equal(hint.inStoreOvertimeHours, 5);
  assert.match(hint.suggestion, /If they can drive/);
});

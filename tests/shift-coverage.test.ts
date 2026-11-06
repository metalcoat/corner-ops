import assert from "node:assert/strict";
import test from "node:test";
import { coverageGroupMessage, coverageShiftLabel, isLateCallOut } from "../src/lib/shift-coverage-rules";

test("a call-out under 4 hours before the shift is late", () => {
  const start = new Date("2026-11-08T21:00:00Z");
  assert.equal(isLateCallOut(start, new Date("2026-11-08T16:59:00Z")), false, "4h01m before");
  assert.equal(isLateCallOut(start, new Date("2026-11-08T17:01:00Z")), true, "3h59m before");
  assert.equal(isLateCallOut(start, new Date("2026-11-08T22:00:00Z")), true, "after the start");
});

test("the group message names the shift but never the reason", () => {
  const shift = coverageShiftLabel(new Date("2026-11-08T21:00:00Z"), new Date("2026-11-09T03:00:00Z"), "Pizza");
  assert.equal(shift, "Sun, Nov 8, 4:00 PM–10:00 PM · Pizza");
  const message = coverageGroupMessage({ name: "Brandon Howie", shift });
  assert.match(message, /^Brandon needs coverage: Sun, Nov 8, 4:00 PM–10:00 PM · Pizza\./);
  assert.match(message, /I'll take it/);
  assert.doesNotMatch(message, /sick/i);
});

import test from "node:test";
import assert from "node:assert/strict";
import { isPrintEverythingDay, isSuperBowlSunday, kitchenReleaseAt } from "../src/lib/ordering-kitchen-release.js";

const now = new Date("2026-11-05T14:00:00Z"); // 9 AM Eastern

test("a future order is held until its prep time before it's due", () => {
  const due = new Date("2026-11-05T22:00:00Z"); // 5 PM Eastern
  assert.equal(kitchenReleaseAt({ timingMode: "future", scheduledFor: due, quotedLeadMaxMinutes: 30, now })?.toISOString(), "2026-11-05T21:20:00.000Z");
  assert.equal(kitchenReleaseAt({ timingMode: "future", scheduledFor: due, quotedLeadMaxMinutes: 0, now })?.toISOString(), "2026-11-05T21:25:00.000Z");
});

test("ASAP orders and future orders already inside the prep window go right away", () => {
  assert.equal(kitchenReleaseAt({ timingMode: "asap", scheduledFor: null, now }), null);
  assert.equal(kitchenReleaseAt({ timingMode: "future", scheduledFor: new Date("2026-11-05T14:30:00Z"), quotedLeadMaxMinutes: 30, now }), null);
});

test("Halloween and Super Bowl Sunday print everything right away", () => {
  assert.equal(isPrintEverythingDay(new Date("2026-10-31T21:00:00Z")), true);
  assert.equal(isPrintEverythingDay(new Date("2026-11-01T03:30:00Z")), true); // 11:30 PM Oct 31 Eastern
  assert.equal(isSuperBowlSunday(new Date("2027-02-14T23:00:00Z")), true);
  assert.equal(isSuperBowlSunday(new Date("2026-02-08T23:00:00Z")), true);
  assert.equal(isSuperBowlSunday(new Date("2027-02-07T23:00:00Z")), false);
  assert.equal(kitchenReleaseAt({ timingMode: "future", scheduledFor: new Date("2026-10-31T22:00:00Z"), quotedLeadMaxMinutes: 30, now: new Date("2026-10-31T13:00:00Z") }), null);
});

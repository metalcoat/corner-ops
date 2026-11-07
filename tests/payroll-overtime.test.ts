import assert from "node:assert/strict";
import test from "node:test";
import { overtimePayCents, splitOvertimeByRole, weightedAverageOvertimeCents } from "../src/lib/payroll-overtime-rules";
import { tippedFullRateCents, tippedOvertimeRateCents } from "../src/lib/ny-tipped-wage";

const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, 2 + day, hour + 5));

test("tipped overtime cash rate: 1.5 x minimum minus the tip credit", () => {
  assert.equal(tippedOvertimeRateCents(1070, 2026), 1870, "$10.70 driver → $18.70");
  assert.equal(tippedOvertimeRateCents(1200, 2026), 2000, "$12.00 driver (credit $4.00) → $20.00");
  assert.equal(tippedOvertimeRateCents(1600, 2026), 2400, "no credit at $16.00 → 1.5 × $16.00");
  assert.equal(tippedOvertimeRateCents(1800, 2026), 2700, "above minimum → 1.5 × rate");
});

test("hours past 40 go to the role being worked at that time", () => {
  // Mon-Thu: 4 × 9 in-store = 36; Fri: 8 driving → hours 37-44 driving, so 4 straight + 4 overtime driving.
  const week = [0, 1, 2, 3].map((d) => ({ start: at(d, 9), hours: 9, tipped: false })).concat([{ start: at(4, 15), hours: 8, tipped: true }]);
  assert.deepEqual(splitOvertimeByRole(week), { regularStraightHours: 36, tippedStraightHours: 4, regularOvertimeHours: 0, tippedOvertimeHours: 4 });
  // Same hours, driving first: overtime lands in-store.
  const flipped = [{ start: at(0, 15), hours: 8, tipped: true }].concat([1, 2, 3, 4].map((d) => ({ start: at(d, 9), hours: 9, tipped: false })));
  assert.deepEqual(splitOvertimeByRole(flipped), { regularStraightHours: 32, tippedStraightHours: 8, regularOvertimeHours: 4, tippedOvertimeHours: 0 });
  // A segment crossing 40 is split.
  const split = splitOvertimeByRole([{ start: at(0, 9), hours: 38, tipped: false }, { start: at(5, 9), hours: 3, tipped: true }, { start: at(5, 12), hours: 2, tipped: false }]);
  assert.deepEqual(split, { regularStraightHours: 38, tippedStraightHours: 2, regularOvertimeHours: 2, tippedOvertimeHours: 1 });
});

test("overtime pay per role", () => {
  const pay = overtimePayCents({ regularStraightHours: 36, tippedStraightHours: 4, regularOvertimeHours: 2, tippedOvertimeHours: 4 }, { regularRateCents: 1700, tippedOvertimeRateCents: 1870 });
  assert.deepEqual(pay, { regularCents: 5100, tippedCents: 7480, totalCents: 12580 });
});

test("without a signed agreement: weighted-average overtime (29 CFR 778.115)", () => {
  assert.equal(tippedFullRateCents(1070, 2026), 1600);
  // 36 h in-store at $17.00 + 8 h driving at $10.70 ($16.00 full), last 4 driving hours are overtime.
  const split = { regularStraightHours: 36, tippedStraightHours: 4, regularOvertimeHours: 0, tippedOvertimeHours: 4 };
  // Regular rate = (36 × 17 + 8 × 16) / 44 = 16.818…; OT pay = 4 × 10.70 + 0.5 × 16.818 × 4 = 42.80 + 33.64 = 76.44
  assert.equal(weightedAverageOvertimeCents(split, { regularRateCents: 1700, tippedCashRateCents: 1070, tippedFullRateCents: 1600 }), 7644);
  // By role the same 4 hours are 4 × $18.70 = $74.80.
  assert.equal(overtimePayCents(split, { regularRateCents: 1700, tippedOvertimeRateCents: 1870 }).totalCents, 7480);
});

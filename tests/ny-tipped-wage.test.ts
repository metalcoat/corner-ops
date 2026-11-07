import assert from "node:assert/strict";
import test from "node:test";
import { nyFoodServiceRates, tipCreditShortfallCents, tippedRateProblem } from "../src/lib/ny-tipped-wage";

test("2026 upstate food service: $10.70 cash + $5.30 credit = $16.00", () => {
  assert.deepEqual(nyFoodServiceRates(2026), { minimumCents: 1600, cashWageCents: 1070, tipCreditCents: 530 });
  assert.deepEqual(nyFoodServiceRates(2027), nyFoodServiceRates(2026), "until next year's row is added");
});

test("a driver rate under the cash wage, or above the regular rate, is refused", () => {
  assert.match(tippedRateProblem({ tippedRateCents: 1000, hourlyRateCents: 1600, year: 2026 }), /\$10\.70/);
  assert.equal(tippedRateProblem({ tippedRateCents: 1070, hourlyRateCents: 1600, year: 2026 }), "");
  assert.match(tippedRateProblem({ tippedRateCents: 1700, hourlyRateCents: 1600, year: 2026 }), /higher/);
  assert.equal(tippedRateProblem({ tippedRateCents: 0, hourlyRateCents: 1600, year: 2026 }), "", "not a driver");
});

test("weekly shortfall: tips have to cover the tip credit for tipped hours", () => {
  // 20 driving hours at $10.70 = $214.00; minimum is $320.00, so tips must be at least $106.00.
  assert.equal(tipCreditShortfallCents({ tippedHours: 20, tippedRateCents: 1070, tipsCents: 10600, year: 2026 }), 0);
  assert.equal(tipCreditShortfallCents({ tippedHours: 20, tippedRateCents: 1070, tipsCents: 8000, year: 2026 }), 2600);
  assert.equal(tipCreditShortfallCents({ tippedHours: 0, tippedRateCents: 1070, tipsCents: 0, year: 2026 }), 0);
  assert.equal(tipCreditShortfallCents({ tippedHours: 10, tippedRateCents: 1600, tipsCents: 0, year: 2026 }), 0, "paid full minimum");
});

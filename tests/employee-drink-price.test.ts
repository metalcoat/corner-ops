import assert from "node:assert/strict";
import test from "node:test";
import { employeeDrinkPriceCents } from "../src/lib/ordering-employee-drink-rules";

test("employee drinks: cost + deposit + 8% tax, rounded up to the next quarter", () => {
  // Chris, 2026-11-06: 20 oz $1.29 + $0.05 deposit → $1.447 → $1.50.
  assert.equal(employeeDrinkPriceCents(129, 5, 800), 150);
  // 2 liter $2.05 + $0.05 deposit → $2.268 → $2.50.
  assert.equal(employeeDrinkPriceCents(205, 5, 800), 250);
  assert.equal(employeeDrinkPriceCents(200, 0, 800), 225, "exactly $2.16 rounds up to $2.25");
  assert.equal(employeeDrinkPriceCents(125, 0, 0), 125, "already on a quarter stays put");
  assert.equal(employeeDrinkPriceCents(126, 0, 0), 150, "a cent over goes to the next quarter");
  assert.equal(employeeDrinkPriceCents(0, 0, 800), 0);
});

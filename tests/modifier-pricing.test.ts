import assert from "node:assert/strict";
import test from "node:test";
import { groupSelectionChargeCents } from "../src/lib/ordering-modifier-pricing";

test("charge-once group (Deluxe): any or all of lettuce, tomato, onion is $0.25 total", () => {
  assert.deepEqual([0, 1, 2, 3].map((count) => groupSelectionChargeCents(25, count)), [0, 25, 25, 25]);
  assert.equal(groupSelectionChargeCents(0, 3), 0);
  assert.equal(groupSelectionChargeCents(undefined, 2), 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { allocateSquareTipAfterFee } from "../src/lib/square-tip-fee.js";

test("deducts at most 3.5% of the tip and preserves every cent across employees", () => {
  const allocations = allocateSquareTipAfterFee(1001, 3, 3000, 120);
  assert.equal(allocations.reduce((sum, row) => sum + row.grossCents, 0), 1001);
  assert.equal(allocations.reduce((sum, row) => sum + row.feeCents, 0), 35);
  assert.equal(allocations.reduce((sum, row) => sum + row.netCents, 0), 966);
  assert.ok(allocations.every((row) => row.grossCents === row.feeCents + row.netCents));
});

test("caps the deduction at the tip's share of Square's actual fee", () => {
  const allocations = allocateSquareTipAfterFee(1000, 2, 5000, 100);
  assert.equal(allocations.reduce((sum, row) => sum + row.feeCents, 0), 20);
  assert.equal(allocations.reduce((sum, row) => sum + row.netCents, 0), 980);
});

test("does not withhold an unverified fee", () => {
  assert.deepEqual(allocateSquareTipAfterFee(101, 2, 500, null), [
    { grossCents: 51, feeCents: 0, netCents: 51 },
    { grossCents: 50, feeCents: 0, netCents: 50 },
  ]);
});

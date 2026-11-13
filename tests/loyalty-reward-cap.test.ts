import assert from "node:assert/strict";
import test from "node:test";
import { loyaltyBaseDiscount, loyaltyUpgrades } from "../src/lib/ordering-loyalty-cap";

test("loyalty cap: no cap takes off the whole base price", () => {
  assert.equal(loyaltyBaseDiscount(1650, null), 1650);
});

test("loyalty cap: a pricier item is discounted only up to the cap", () => {
  assert.equal(loyaltyBaseDiscount(1650, 1550), 1550);
  assert.equal(loyaltyBaseDiscount(1550, 1550), 1550);
  assert.equal(loyaltyBaseDiscount(1200, 1550), 1200);
  assert.equal(loyaltyBaseDiscount(1650, -5), 0);
});

test("loyalty cap: upgrade hints list only pricier reward variants", () => {
  const variants = [
    { id: "thin", name: 'Jumbo Thin 16"', priceCents: 1550 },
    { id: "thick", name: 'Jumbo Thick 16"', priceCents: 1650 },
    { id: "same", name: "Same price", priceCents: 1550 },
  ];
  assert.deepEqual(loyaltyUpgrades(1550, "thin", variants), [{ variantId: "thick", name: 'Jumbo Thick 16"', extraCents: 100 }]);
  assert.deepEqual(loyaltyUpgrades(null, "thin", variants), []);
  assert.deepEqual(loyaltyUpgrades(1550, null, variants), []);
});

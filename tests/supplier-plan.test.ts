import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSuppliers, casesFor, convertUnits, nextDelivery, unitCostCents, type SupplierTerms } from "../src/lib/supplier-plan.js";

const terms = (id: string, extra: Partial<SupplierTerms> = {}): SupplierTerms => ({
  id, name: id, minimumOrderCents: 0, deliveryFeeCents: 0, freeDeliveryOverCents: null,
  deliveryDays: [], cutoffTime: "16:00", cutoffDaysBefore: 1, shipsInDays: null, ...extra,
});

test("case prices convert to the item's unit", () => {
  assert.equal(convertUnits(2, "lb", "oz"), 32);
  assert.equal(convertUnits(1, "gallons", "qt")?.toFixed(2), "4.00");
  assert.equal(convertUnits(3, "dozen", "each"), 36);
  assert.equal(convertUnits(1, "lb", "each"), null);
  // 4 × 5 lb case of turkey for $80 = $1/lb... expressed as 16 oz
  assert.equal(unitCostCents({ supplierId: "s", itemId: "i", caseQuantity: 20, caseUnit: "lb", casePriceCents: 8000 }, "lb"), 400);
  assert.equal(casesFor(21, { supplierId: "s", itemId: "i", caseQuantity: 20, caseUnit: "lb", casePriceCents: 1 }, "lb"), 2);
  assert.equal(casesFor(0, { supplierId: "s", itemId: "i", caseQuantity: 20, caseUnit: "lb", casePriceCents: 1 }, "lb"), 0);
});

test("next truck respects the order-by cutoff in New York time", () => {
  // Monday 2026-10-05 10:00 EDT. Thursday truck, order by 4pm Wednesday.
  const monday = new Date("2026-10-05T14:00:00Z");
  const w = nextDelivery({ deliveryDays: [4], cutoffTime: "16:00", cutoffDaysBefore: 1, shipsInDays: null }, monday)!;
  assert.equal(w.deliveryDate, "2026-10-08");
  assert.equal(w.orderBy, "2026-10-07T20:00:00.000Z");
  // Wednesday 5pm: missed it, next Thursday.
  const late = nextDelivery({ deliveryDays: [4], cutoffTime: "16:00", cutoffDaysBefore: 1, shipsInDays: null }, new Date("2026-10-07T21:00:00Z"))!;
  assert.equal(late.deliveryDate, "2026-10-15");
  // Shipped supplier: 3 business days from Friday lands Wednesday.
  assert.equal(nextDelivery({ deliveryDays: [], cutoffTime: "", cutoffDaysBefore: 0, shipsInDays: 3 }, new Date("2026-10-09T15:00:00Z"))!.deliveryDate, "2026-10-14");
});

test("cheapest split respects minimums and fees", () => {
  const items = [
    { id: "turkey", name: "Turkey", baseUnit: "lb", need: 40 },
    { id: "cups", name: "Cups", baseUnit: "each", need: 1000 },
  ];
  const offers = [
    { supplierId: "A", itemId: "turkey", caseQuantity: 20, caseUnit: "lb", casePriceCents: 8000 },
    { supplierId: "B", itemId: "turkey", caseQuantity: 20, caseUnit: "lb", casePriceCents: 7600 },
    { supplierId: "A", itemId: "cups", caseQuantity: 1000, caseUnit: "each", casePriceCents: 5000 },
    { supplierId: "W", itemId: "cups", caseQuantity: 1000, caseUnit: "each", casePriceCents: 3000 },
  ];
  // No minimums or fees: B turkey + W cups.
  let result = analyzeSuppliers(items, offers, [terms("A"), terms("B"), terms("W")]);
  assert.equal(result.best!.totalCents, 15200 + 3000);
  assert.equal(result.floorCents, 18200);
  // W charges $25 shipping: buying cups from A instead is cheaper only if it saves more than $5 difference... it doesn't ($20 more), so the fee flips it.
  result = analyzeSuppliers(items, offers, [terms("A"), terms("B"), terms("W", { deliveryFeeCents: 2500 })]);
  assert.equal(result.best!.label, "A + B");
  assert.equal(result.best!.totalCents, 15200 + 5000);
  // B has a $200 minimum: turkey alone ($152) doesn't make it, so everything from A or top up.
  result = analyzeSuppliers(items, offers, [terms("A"), terms("B", { minimumOrderCents: 20000 }), terms("W")]);
  assert.ok(result.best!.meetsMinimums);
  assert.equal(result.best!.label, "A + W");
  assert.equal(result.best!.totalCents, 16000 + 3000);
  const single = result.single.find((plan) => plan.label.endsWith("B"))!;
  assert.deepEqual(single.missing, ["cups"]);
  assert.equal(single.orders[0].shortOfMinimumCents, 20000 - 15200);
});

test("a supplier that can't deliver before an item runs out loses to one that can", () => {
  const items = [{ id: "bread", name: "Bread", baseUnit: "each", need: 10, runOutDate: "2026-10-07" }];
  const offers = [
    { supplierId: "slow", itemId: "bread", caseQuantity: 10, caseUnit: "each", casePriceCents: 1000 },
    { supplierId: "fast", itemId: "bread", caseQuantity: 10, caseUnit: "each", casePriceCents: 1500 },
  ];
  const now = new Date("2026-10-05T14:00:00Z");
  const result = analyzeSuppliers(items, offers, [terms("slow", { deliveryDays: [4] }), terms("fast", { deliveryDays: [2] })], now);
  assert.equal(result.best!.label, "fast");
  assert.equal(result.best!.lateItems, 0);
});

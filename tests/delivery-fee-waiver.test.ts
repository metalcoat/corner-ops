import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryFeeWaiverFor,
  evaluateDeliveryMinimum,
  normalizeStreetLine,
  validateDeliveryForConfirmation,
} from "../src/lib/ordering-delivery-core.js";

const BOWL = "Delivery fee waived (Ogdensburg Bowl)";

test("street lines normalize case, punctuation and street words", () => {
  assert.equal(normalizeStreetLine("1121 Paterson Street."), "1121 paterson st");
  assert.equal(normalizeStreetLine("  1121  PATERSON  ST "), "1121 paterson st");
  assert.equal(normalizeStreetLine("1121 Paterson St,"), "1121 paterson st");
});

test("the Ogdensburg Bowl gets no delivery fee however the address is written", () => {
  for (const address of [
    { line1: "1121 Paterson St", postalCode: "13669" },
    { line1: "1121 Paterson Street" },
    { line1: "1121 paterson st." },
    { formattedAddress: "1121 Paterson St, Ogdensburg, NY 13669, USA" },
    { formattedAddress: "1121 PATERSON STREET, Ogdensburg NY 13669-1234" },
    { formattedAddress: "1121 Paterson St" },
  ]) {
    assert.equal(deliveryFeeWaiverFor(address)?.label, BOWL, JSON.stringify(address));
  }
});

test("other addresses keep the delivery fee", () => {
  for (const address of [
    null,
    undefined,
    {},
    { line1: "1120 Paterson St", postalCode: "13669" },
    { line1: "121 Paterson St" },
    { line1: "1121 Paterson Ave" },
    { line1: "1121 Ford St" },
    { formattedAddress: "11211 Paterson St, Ogdensburg, NY 13669, USA" },
    // Same street line in another town is not the bowl.
    { line1: "1121 Paterson St", postalCode: "13601" },
    { formattedAddress: "1121 Paterson St, Watertown, NY 13601, USA" },
  ]) {
    assert.equal(deliveryFeeWaiverFor(address), null, JSON.stringify(address));
  }
});

test("a waived fee does not change the delivery minimum", () => {
  const charged = evaluateDeliveryMinimum({ merchandiseSubtotalCents: 1000, deliveryFeeCents: 400, minimumOrderCents: 1500 });
  const waived = evaluateDeliveryMinimum({ merchandiseSubtotalCents: 1000, deliveryFeeCents: 0, minimumOrderCents: 1500 });
  assert.equal(waived.shortfallCents, 500);
  assert.equal(waived.shortfallCents, charged.shortfallCents);
  assert.equal(waived.resolution, charged.resolution);
});

test("a zero delivery fee still passes the send gate", () => {
  assert.deepEqual(validateDeliveryForConfirmation({
    serviceType: "delivery",
    distanceMiles: 1.2,
    deliveryFeeCents: 0,
    merchandiseSubtotalCents: 2000,
    minimumOrderCents: 1500,
    minimumAdjustmentCents: 0,
    minimumBypassApproved: false,
  }), []);
});

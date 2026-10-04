import assert from "node:assert/strict";
import test from "node:test";
import { driverSettlementError, maxTipCents, tipAllocationTarget, tipChangeError, type TipChangeInput } from "../src/lib/ordering-payment-rules";
import { isProductionHost, localDevToolsAllowed } from "../src/lib/local-dev-tools";

const base: TipChangeInput = { tipCents: 500, currentTipCents: 0, subtotalCents: 2000, totalCents: 2160, paidCents: 0, orderStatus: "draft", voided: false, paymentStatus: "unpaid", isManager: false };

test("tip cap is the greater of $100 or the subtotal", () => {
  assert.equal(maxTipCents(2000), 10_000);
  assert.equal(maxTipCents(25_000), 25_000);
  assert.equal(maxTipCents(-5), 10_000);
  assert.equal(tipChangeError({ ...base, tipCents: 10_000 }), null);
  assert.match(tipChangeError({ ...base, tipCents: 10_001 }) || "", /cannot exceed \$100\.00/);
  assert.match(tipChangeError({ ...base, tipCents: 100, resultingOrderTipCents: 10_100 }) || "", /cannot exceed/);
});

test("staff may tip an unpaid order but need a manager once payment exists", () => {
  assert.equal(tipChangeError(base), null);
  assert.match(tipChangeError({ ...base, paidCents: 2160, paymentStatus: "paid" }) || "", /Manager or owner/);
  assert.equal(tipChangeError({ ...base, paidCents: 2160, paymentStatus: "paid", isManager: true }), null);
  assert.equal(tipChangeError({ ...base, tipCents: 0, currentTipCents: 0, paidCents: 2160, paymentStatus: "paid" }), null);
});

test("tips are rejected on voided/refunded orders and cannot drop the total below what was paid", () => {
  assert.match(tipChangeError({ ...base, voided: true }) || "", /voided/);
  assert.match(tipChangeError({ ...base, orderStatus: "cancelled" }) || "", /voided or cancelled/);
  assert.match(tipChangeError({ ...base, paymentStatus: "refunded", isManager: true }) || "", /refund/);
  assert.match(tipChangeError({ ...base, tipCents: 0, currentTipCents: 500, totalCents: 2660, paidCents: 2660, paymentStatus: "paid", isManager: true }) || "", /below what has already been paid/);
  assert.match(tipChangeError({ ...base, tipCents: -1 }) || "", /non-negative/);
});

test("tip allocation target is zero unless the order is paid and not voided", () => {
  assert.equal(tipAllocationTarget({ tipCents: 400, paymentStatus: "paid", voided: false, status: "completed" }), 400);
  assert.equal(tipAllocationTarget({ tipCents: 400, paymentStatus: "paid", voided: true, status: "cancelled" }), 0);
  assert.equal(tipAllocationTarget({ tipCents: 400, paymentStatus: "partially_paid", voided: false, status: "completed" }), 0);
  assert.equal(tipAllocationTarget({ tipCents: 400, paymentStatus: "unpaid", voided: false, status: "completed" }), 0);
});

test("driver cash-out requires a driver on their own orders and a manager for shortfalls", () => {
  const ok = { isDriver: true, isManager: false, expectedCents: 5000, turnedInCents: 5000, unassignedOrderCount: 0 };
  assert.equal(driverSettlementError(ok), null);
  assert.equal(driverSettlementError({ ...ok, turnedInCents: 5200 }), null);
  assert.match(driverSettlementError({ ...ok, isDriver: false }) || "", /Driver or manager access/);
  assert.match(driverSettlementError({ ...ok, unassignedOrderCount: 1 }) || "", /assigned to them/);
  assert.match(driverSettlementError({ ...ok, turnedInCents: 0 }) || "", /\$50\.00 short/);
  assert.equal(driverSettlementError({ ...ok, isDriver: false, isManager: true, turnedInCents: 0, unassignedOrderCount: 3 }), null);
});

test("local dev tools are refused on production hosts even with LOCAL_DEVELOPMENT", () => {
  assert.equal(localDevToolsAllowed({ LOCAL_DEVELOPMENT: "true", NODE_ENV: "production", APP_URL: "http://192.168.1.237:3000" }, "dev.ordercornerdeli.com"), true);
  assert.equal(localDevToolsAllowed({ NODE_ENV: "development" }), false);
  assert.equal(localDevToolsAllowed({ LOCAL_DEVELOPMENT: "true", VERCEL: "1" }), false);
  assert.equal(localDevToolsAllowed({ LOCAL_DEVELOPMENT: "true", VERCEL_ENV: "production" }), false);
  assert.equal(localDevToolsAllowed({ LOCAL_DEVELOPMENT: "true", APP_URL: "https://corner-ops.vercel.app" }), false);
  assert.equal(localDevToolsAllowed({ LOCAL_DEVELOPMENT: "true" }, "corner-ops.vercel.app"), false);
  assert.equal(isProductionHost("https://preview-123.vercel.app/x"), true);
  assert.equal(isProductionHost("127.0.0.1:3000"), false);
});

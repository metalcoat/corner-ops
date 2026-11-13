import assert from "node:assert/strict";
import test from "node:test";
import { orderPaymentState } from "../src/lib/order-payment-state";

const base = { status: "ready", paymentStatus: "paid", voided: false, paidCents: 1000, dueCents: 0, refundedCents: 0 };

test("a refunded order that was still open reads Refunded, not unpaid", () => {
  // What reverseTender used to leave behind: unpaid, the whole total due again.
  const state = orderPaymentState({ ...base, paymentStatus: "unpaid", paidCents: 0, dueCents: 1000, refundedCents: 1000 });
  assert.equal(state.label, "Refunded");
  assert.equal(state.owes, false);
});

test("part refunded reads Partially refunded and owes nothing", () => {
  const state = orderPaymentState({ ...base, paymentStatus: "partially_paid", paidCents: 700, dueCents: 300, refundedCents: 300 });
  assert.deepEqual([state.key, state.owes], ["partially_refunded", false]);
  assert.equal(orderPaymentState({ ...base, status: "completed", paymentStatus: "partially_refunded", paidCents: 700, refundedCents: 300 }).label, "Partially refunded");
});

test("a draft at checkout with a wrong tender taken off still owes", () => {
  const state = orderPaymentState({ ...base, status: "draft", paymentStatus: "unpaid", paidCents: 0, dueCents: 1000, refundedCents: 1000 });
  assert.deepEqual([state.label, state.owes], ["Unpaid", true]);
});

test("paid again after a reversal reads Paid", () => {
  assert.equal(orderPaymentState({ ...base, refundedCents: 1000 }).label, "Paid");
});

test("voided orders say whether the money went back", () => {
  assert.equal(orderPaymentState({ ...base, status: "cancelled", voided: true, paymentStatus: "unpaid", paidCents: 0, dueCents: 1000, refundedCents: 1000 }).label, "Voided · refunded");
  assert.equal(orderPaymentState({ ...base, status: "cancelled", voided: true }).label, "Voided · not refunded");
  assert.equal(orderPaymentState({ ...base, status: "cancelled", voided: true, paidCents: 0, paymentStatus: "unpaid", dueCents: 1000 }).label, "Voided");
});

test("an unpaid order still owes", () => {
  assert.deepEqual(orderPaymentState({ ...base, paymentStatus: "unpaid", paidCents: 0, dueCents: 1000 }), { key: "owes", label: "Unpaid", owes: true });
  assert.equal(orderPaymentState({ ...base, paymentStatus: "partially_paid", paidCents: 400, dueCents: 600 }).label, "Owes $6.00");
});

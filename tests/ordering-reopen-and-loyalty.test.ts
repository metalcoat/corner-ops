import test from "node:test";
import assert from "node:assert/strict";
import { abandonedReopenRestoreStatus, effectiveReopen } from "../src/lib/ordering-reopen-policy.js";
import { loyaltyEarnIncrement, loyaltyEarnPaymentEligible } from "../src/lib/ordering-loyalty-earn.js";

test("a reopen logged on a never-sent draft is treated as a first submit", () => {
  assert.equal(effectiveReopen({ previousStatus: "draft", existingItemIds: ["a"] }), undefined);
  assert.equal(effectiveReopen(undefined), undefined);
  const sent = { previousStatus: "in_progress", existingItemIds: ["a"] };
  assert.equal(effectiveReopen(sent), sent);
});

test("an abandoned reopen without changes restores its prior status", () => {
  const details = { previousStatus: "in_progress", existingItemIds: ["a", "b"] };
  assert.equal(abandonedReopenRestoreStatus(details, ["a", "b"], false), "in_progress");
  assert.equal(abandonedReopenRestoreStatus(details, ["a"], false), "in_progress");
});

test("an abandoned reopen with unsent changes stays in draft", () => {
  const details = { previousStatus: "ready", existingItemIds: ["a"] };
  assert.equal(abandonedReopenRestoreStatus(details, ["a", "new"], false), null);
  assert.equal(abandonedReopenRestoreStatus(details, ["a"], true), null);
  assert.equal(abandonedReopenRestoreStatus({ previousStatus: "draft", existingItemIds: ["a"] }, ["a"], false), null);
  assert.equal(abandonedReopenRestoreStatus({ previousStatus: "cancelled", existingItemIds: ["a"] }, ["a"], false), null);
});

test("loyalty earns add-on units incrementally", () => {
  assert.deepEqual(loyaltyEarnIncrement(2, 0), { delta: 2, earnedThroughUnits: 2 });
  // Add-on of 3 more qualifying units after the first submit.
  assert.deepEqual(loyaltyEarnIncrement(5, 2), { delta: 3, earnedThroughUnits: 5 });
});

test("loyalty retries and reductions never double-earn or go negative", () => {
  assert.deepEqual(loyaltyEarnIncrement(5, 5), { delta: 0, earnedThroughUnits: 5 });
  assert.deepEqual(loyaltyEarnIncrement(3, 5), { delta: 0, earnedThroughUnits: 5 });
  assert.deepEqual(loyaltyEarnIncrement(0, 0), { delta: 0, earnedThroughUnits: 0 });
});

test("loyalty requires the full payment before a purchase funds rewards",()=>{
  const unpaid={payment_status:"unpaid",paid_cents:0,total_cents:1000,amount_due_cents:1000};
  assert.equal(loyaltyEarnPaymentEligible(unpaid),false);
  assert.equal(loyaltyEarnPaymentEligible({...unpaid,payment_status:"partially_paid",paid_cents:500,amount_due_cents:500}),false);
  assert.equal(loyaltyEarnPaymentEligible({...unpaid,payment_status:"paid"}),false);
  assert.equal(loyaltyEarnPaymentEligible({...unpaid,payment_status:"paid",paid_cents:1000,amount_due_cents:0}),true);
  assert.equal(loyaltyEarnPaymentEligible({...unpaid,payment_status:"refunded",amount_due_cents:0}),false);
});

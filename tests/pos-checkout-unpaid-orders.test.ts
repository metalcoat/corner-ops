import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutNeedsSendDetails, paymentBlocker } from "../src/lib/ordering-payment-rules";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const orders = read("src/app/pos/deli/orders/order-center-client.tsx");
const pos = read("src/app/pos/pos-client.tsx");
const payments = read("src/lib/ordering-payments.ts");

test("an order that still owes money can be paid in every non-void status", () => {
  for (const status of ["draft", "confirmed", "sent_to_kitchen", "in_progress", "ready", "completed"]) {
    assert.equal(paymentBlocker({ status, voided: false }), null, status);
  }
});

test("voided orders still cannot take a payment", () => {
  assert.match(paymentBlocker({ status: "cancelled", voided: true }) || "", /voided/);
  assert.match(paymentBlocker({ status: "cancelled", voided: false }) || "", /voided/);
  assert.match(paymentBlocker({ status: "completed", voided: true }) || "", /voided/);
});

test("only a never-sent draft needs the send details before checkout", () => {
  assert.equal(checkoutNeedsSendDetails("draft"), true);
  for (const status of ["confirmed", "sent_to_kitchen", "in_progress", "ready", "completed"]) {
    assert.equal(checkoutNeedsSendDetails(status), false, status);
  }
  assert.match(payments, /if \(!checkoutNeedsSendDetails\(String\(order\.status\)\)\) return;/);
});

test("card sales check for a void before MX is asked to charge", () => {
  assert.match(read("src/app/api/ordering/orders/[id]/payments/mx/route.ts"), /action === "initialize"\) \{\s*await assertOrderCanTakePayment\(/);
  assert.match(read("src/lib/mx-terminal-payments.ts"), /export async function startTerminalPayment[\s\S]{0,500}?await assertOrderCanTakePayment\(/);
});

test("TAKE PAYMENT on a sent order opens checkout without reopening it", () => {
  const take = orders.match(/function takePayment\(order: Order\) \{([\s\S]*?)\n  \}/);
  assert.ok(take, "takePayment not found");
  const sentBranch = take[1].match(/if \(order\.status !== "draft"\) \{([\s\S]*?)return;\s*\}/);
  assert.ok(sentBranch, "sent-order branch not found");
  assert.match(sentBranch[1], /"corner-ops-checkout-order"/);
  assert.match(sentBranch[1], /checkoutOnly: true, sentOrder: true/);
  assert.doesNotMatch(sentBranch[1], /reopen\(/);
  // Never-sent drafts still confirm, then load whole into the POS.
  assert.match(take[1], /window\.confirm[\s\S]*void reopen\(order, true\);/);
});

test("the POS CHECKOUT button works on a checkout-only order without the new-order send rules", () => {
  assert.match(pos, /\(Boolean\(sendRequirement\) && !savedDraft\?\.checkoutOnly\)\s*\}\s*onClick=\{\(\) => void openCheckout\(\)\}/);
  assert.match(pos, /const target = draftOverride \|\| savedDraft;\s*if \(sendRequirement && !target\?\.reopened && !target\?\.checkoutOnly\)/);
});

test("editing a sent order from checkout goes through Orders, which reopens it", () => {
  const edits = pos.match(/if \(savedDraft\?\.sentOrder\) \{\s*window\.location\.assign\(`\/pos\/deli\/orders\?orderId=/g) || [];
  assert.equal(edits.length, 2);
});

test("paying an order that was already sent does not send it to the kitchen again", () => {
  const route = read("src/app/api/ordering/orders/[id]/payments/route.ts");
  assert.match(route, /result\.order\.payment_status==="paid"&&result\.order\.status==="draft"\)\{\s*const unsent=await submitPaidDraft/);
  assert.match(route, /else await dispatchOrderPrintJobs\(id,business,\{includeKitchenProduction:false\}\)/);
});

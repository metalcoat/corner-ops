#!/usr/bin/env node
// Adding a fee and tip to the card an order was paid with, against the MX *sandbox* (refuses production):
// the same MX payment goes up, nothing is charged twice on a retry, and refunds only take back what they should.
// Database fixtures are rolled back; the sandbox charge is voided.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:add-to-card-validation";

async function main(): Promise<void> {
  if (process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production") throw new Error("MX sandbox only.");
  const { getSql, outsideTransaction, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder } = await import("../src/lib/ordering-order-lifecycle");
  const { commitTender, reverseTender, setCheckoutTip, PaymentConflictError } = await import("../src/lib/ordering-payments");
  const { getMxPayment, newReplayId, submitMxVoicePayment, voidOrRefundMxPayment } = await import("../src/lib/mx-merchant");
  const { addToMxCard } = await import("../src/lib/mx-add-to-card");
  await ensureOrderingPosSchema();
  const manager = { id: "add-to-card-manager", name: "Manager", type: "employee" as const, role: "manager" as const };
  const results: Record<string, unknown> = {};
  let paymentId = "";
  const sourceIds: string[] = [];
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const item = (await sql`
        SELECT i.id FROM ordering_menu_items i
        WHERE i.business='Corner Deli' AND i.active AND i.available AND i.base_price_cents>0
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id)
        ORDER BY i.base_price_cents DESC LIMIT 1`)[0];
      const draft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: manager.id,
        customerFirstName: "Card", callerPhone: "3155550184", items: [{ itemId: String(item.id), quantity: 1 }],
      });
      const orderId = String(draft.id);
      await submitDraftOrder(orderId, "Corner Deli", manager);
      const totalCents = Number((await sql`SELECT total_cents FROM ordering_orders WHERE id=${orderId}`)[0].total_cents);
      const first = await submitMxVoicePayment({ amountCents: totalCents, replayId: newReplayId(), cardNumber: "4111111111111111", expiryMonth: "12", expiryYear: "2029", cvv: "123", avsZip: "13669", avsStreet: "1 Main St" }) as Record<string, any>;
      paymentId = String(first.id);
      await commitTender({ orderId, business: "Corner Deli", tenderType: "card", amountTenderedCents: totalCents, clientMutationId: randomUUID(), actor: manager, providerApproval: { provider: "mx_merchant", transactionReference: paymentId, brand: String(first.cardAccount?.cardType || ""), last4: String(first.cardAccount?.last4 || ""), details: {} } });

      // The fee: a $4 balance goes on the same MX payment.
      await sql`UPDATE ordering_orders SET delivery_fee_cents=400,total_cents=total_cents+400,amount_due_cents=400,payment_status='partially_paid' WHERE id=${orderId}`;
      await setCheckoutTip({ orderId, business: "Corner Deli", tipCents: 300, newCharge: true, actor: manager });
      const mutation = randomUUID();
      const added = await addToMxCard({ orderId, business: "Corner Deli", amountCents: 700, tipCents: 300, clientMutationId: mutation, actor: manager });
      assert.equal(added.order.payment_status, "paid");
      let mx = await getMxPayment(paymentId) as Record<string, unknown>;
      assert.equal(Math.round(Number(mx.amount) * 100), totalCents + 700);
      assert.equal(Math.round(Number(mx.tip) * 100), 300);
      results.sameMxPaymentRaised = { from: totalCents, to: totalCents + 700, tip: 300 };

      const lines = await sql`SELECT id,amount_cents,details FROM ordering_payment_transactions WHERE order_id=${orderId} AND transaction_type='payment' ORDER BY created_at`;
      assert.equal(lines.length, 2);
      assert.equal(lines[1].details.addedToMxPayment, paymentId);
      sourceIds.push(...lines.map((row) => String(row.id)));

      // A repeat of the same request can't add it twice.
      await addToMxCard({ orderId, business: "Corner Deli", amountCents: 700, tipCents: 300, clientMutationId: mutation, actor: manager });
      await assert.rejects(addToMxCard({ orderId, business: "Corner Deli", amountCents: 700, tipCents: 300, clientMutationId: randomUUID(), actor: manager }), PaymentConflictError);
      mx = await getMxPayment(paymentId) as Record<string, unknown>;
      const repeated = Math.round(Number(mx.amount) * 100);
      results.repeatAddsNothing = repeated === totalCents + 700;
      assert.equal(repeated, totalCents + 700);

      // Refunding the fee takes back only that part: the rest of the payment stays charged.
      await reverseTender({ orderId, business: "Corner Deli", transactionId: String(lines[1].id), amountCents: 700, clientMutationId: randomUUID(), reason: "Fee refund test", actor: manager });
      mx = await getMxPayment(paymentId) as Record<string, unknown>;
      results.afterAddOnRefund = { status: mx.status, amount: mx.amount };
      assert.match(String(mx.status), /approve/i);
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  } finally {
    if (paymentId) results.sandboxChargeVoided = await voidOrRefundMxPayment(paymentId).then(() => true, (error) => String(error?.message || error));
    if (sourceIds.length) await outsideTransaction(() => getSql()`DELETE FROM ordering_mx_reversal_attempts WHERE source_transaction_id=ANY(${sourceIds})`);
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

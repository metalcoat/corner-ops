// Adds a delivery fee or tip to the card an order was already paid with. MX lets a sale be raised
// until its batch settles (PUT /payment/{id} with the sale's paymentToken), so the customer doesn't
// read the card out again and it stays one charge on their statement. After settlement MX refuses
// and the POS falls back to a saved card or the card number.
import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { adjustMxPayment, getMxPayment, MxMerchantError, MxMerchantUnreachableError } from "@/lib/mx-merchant";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { checkoutState, commitTender, PaymentConflictError } from "@/lib/ordering-payments";
import type { OrderingActor } from "@/lib/ordering-route-auth";

const amountCents = (value: unknown) => Math.round(Number(value || 0) * 100);

const commitDuplicate = async (input: { orderId: string; business: OrderingBusiness; checkId?: string | null }) => ({ ...(await checkoutState(input.orderId, input.business, input.checkId || null)), duplicate: true });

export async function addToMxCard(input: { orderId: string; business: OrderingBusiness; checkId?: string | null; amountCents: number; tipCents: number; clientMutationId: string; actor: OrderingActor }) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new PaymentConflictError("Enter an amount to add to the card.");
  if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0 || input.tipCents > input.amountCents) throw new PaymentConflictError("Enter a valid tip.");
  const sql = getSql();
  // Both are checked before MX is called: the amount at MX is what gets charged, so a repeat must never reach it.
  if ((await sql`SELECT 1 FROM ordering_payment_transactions WHERE business=${input.business} AND client_mutation_id=${input.clientMutationId} LIMIT 1`).length) return commitDuplicate(input);
  const state = await checkoutState(input.orderId, input.business, input.checkId || null);
  if (input.amountCents > Number(state.check?.amount_due_cents ?? state.order.amount_due_cents)) throw new PaymentConflictError("That's more than this order still owes. Refresh and check the balance.");
  const source = (await sql`SELECT * FROM ordering_payment_transactions WHERE order_id=${input.orderId} AND business=${input.business} AND tender_type='card' AND provider='mx_merchant' AND transaction_type='payment' AND status='approved' ORDER BY created_at DESC LIMIT 1`)[0];
  if (!source) throw new MxMerchantError("This order has no card payment to add to.");
  const paymentId = String(source.details?.addedToMxPayment || source.provider_transaction_reference || "");
  const rows = await sql`SELECT t.amount_cents,COALESCE((SELECT SUM(r.amount_cents) FROM ordering_payment_transactions r WHERE r.related_transaction_id=t.id AND r.transaction_type IN('void','refund') AND r.status='approved'),0) reversed_cents
    FROM ordering_payment_transactions t WHERE t.order_id=${input.orderId} AND t.provider='mx_merchant' AND t.transaction_type='payment' AND t.status='approved' AND (t.provider_transaction_reference=${paymentId} OR t.details->>'addedToMxPayment'=${paymentId})`;
  const recordedCents = rows.reduce((sum, row) => sum + Number(row.amount_cents) - Number(row.reversed_cents), 0);
  if (recordedCents <= 0) throw new MxMerchantError("That card payment was refunded, so nothing can be added to it.");

  const payment = await getMxPayment(paymentId) as Record<string, unknown>;
  if (!String(payment.status || "").toLowerCase().includes("approve") || !payment.paymentToken) throw new MxMerchantError("MX won't change that card payment. Use another card.");
  const atMxCents = amountCents(payment.amount), targetCents = recordedCents + input.amountCents;
  // MX already at the new amount means an earlier try went through but its answer was lost.
  if (atMxCents !== targetCents) {
    if (atMxCents !== recordedCents) throw new MxMerchantError("MX's amount for this card doesn't match the order. Check it in MX Merchant, or use another card.");
    try {
      await adjustMxPayment({ paymentId, paymentToken: String(payment.paymentToken), amountCents: targetCents, tipCents: amountCents(payment.tip) + input.tipCents });
    } catch (error) {
      if (!(error instanceof MxMerchantUnreachableError)) throw error;
    }
    const after = await getMxPayment(paymentId) as Record<string, unknown>;
    if (amountCents(after.amount) !== targetCents) throw new MxMerchantError("MX didn't add this to the card, usually because the card's batch has closed. Use a saved card or take the card number.");
  }
  return commitTender({
    orderId: input.orderId, business: input.business, tenderType: "card", amountTenderedCents: input.amountCents, clientMutationId: input.clientMutationId, checkId: input.checkId || null, actor: input.actor,
    providerApproval: {
      provider: "mx_merchant",
      // MX has one payment; each amount added to it needs its own line here, and refunds go to `addedToMxPayment`.
      transactionReference: `${paymentId}:add:${randomUUID().slice(0, 8)}`,
      brand: String(source.brand || ""), last4: String(source.last4 || ""),
      details: { addedToMxPayment: paymentId, channel: "pos_add_to_card", tipCents: input.tipCents, customerConsented: true },
    },
  });
}

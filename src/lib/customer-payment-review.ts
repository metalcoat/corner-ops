import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureMxPaymentSchema, getMxPayment } from "@/lib/mx-merchant";
import { PaymentConflictError } from "@/lib/ordering-payments";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import type { OrderingBusiness } from "@/lib/ordering-core";

/** Legacy web sessions used keyed; the web actor and source distinguish staff key-ins. */
export async function listWebPaymentsNeedingReview(business: OrderingBusiness) {
  await ensureMxPaymentSchema();
  return getSql()`SELECT session.id,session.order_id,orders.display_number,session.amount_cents,
      session.provider_transaction_reference,session.status_message,session.created_at,'web' AS review_kind
    FROM ordering_mx_checkout_sessions session JOIN ordering_orders orders ON orders.id=session.order_id
    WHERE session.business=${business} AND orders.source='web'
      AND (session.channel='online' OR (session.channel='keyed' AND session.created_by LIKE 'web:%'))
      AND session.status='needs_review' ORDER BY session.created_at`;
}

/** Resolve only after MX confirms the original charge was voided or fully refunded. */
export async function resolveWebPaymentReview(input: { business: OrderingBusiness; sessionId: string; note: string; actor: OrderingActor }) {
  if (!canManagePos(input.actor)) throw new PaymentConflictError("Only a manager can resolve an online charge.");
  const note = input.note.trim().slice(0, 500);
  if (note.length < 3) throw new PaymentConflictError("Say what was done in MX (for example, \"refunded in MX\").");
  await ensureMxPaymentSchema();
  const [session] = await getSql()`SELECT session.* FROM ordering_mx_checkout_sessions session JOIN ordering_orders orders ON orders.id=session.order_id
    WHERE session.id=${input.sessionId} AND session.business=${input.business} AND orders.source='web'
      AND (session.channel='online' OR (session.channel='keyed' AND session.created_by LIKE 'web:%'))
      AND session.status='needs_review'`;
  if (!session) throw new PaymentConflictError("That online charge is not waiting for review.");
  const reference = String(session.provider_transaction_reference || "");
  if (!reference) throw new PaymentConflictError("The processor reference is missing. Contact support before taking another payment.");
  let payment: Record<string, unknown>;
  try { payment = await getMxPayment(reference); }
  catch { throw new PaymentConflictError("MX could not verify this charge. Leave it for review and try again when MX is available."); }
  const status = String(payment.status || "").trim().toLowerCase();
  const amount = Math.round(Math.abs(Number(payment.amount)) * 100);
  const refunded = Math.round(Math.abs(Number(payment.refundedAmount || 0)) * 100);
  if (String(payment.id || payment.reference || "") !== reference || amount !== Number(session.amount_cents))
    throw new PaymentConflictError("MX returned a different payment reference or amount. Leave this charge for review.");
  if (!["void", "voided"].includes(status) && !(amount > 0 && refunded >= amount))
    throw new PaymentConflictError("MX still shows money charged to this card. Void or fully refund that payment in MX Merchant, then verify it again here.");
  return withTransaction(async () => {
    const sql = getSql();
    await sql`SELECT id FROM ordering_orders WHERE id=${session.order_id} AND business=${input.business} FOR UPDATE`;
    const [current] = await sql`SELECT status,provider_transaction_reference FROM ordering_mx_checkout_sessions WHERE id=${input.sessionId} FOR UPDATE`;
    if (current?.status === "voided") return { duplicate: true };
    if (current?.status !== "needs_review" || current.provider_transaction_reference !== reference)
      throw new PaymentConflictError("This review changed. Refresh before continuing.");
    await sql`UPDATE ordering_mx_checkout_sessions SET status='voided',reviewed_by=${input.actor.id},reviewed_at=NOW(),review_note=${note},status_message='Manager verified the original online payment was fully reversed at MX.' WHERE id=${input.sessionId}`;
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)
      SELECT ${randomUUID()},id,version,'online_payment_reversal_reviewed',${input.actor.type},${input.actor.id},${JSON.stringify({ sessionId: input.sessionId, processorReference: reference, amountCents: amount, processorStatus: status, note, actorName: input.actor.name })}::jsonb
      FROM ordering_orders WHERE id=${session.order_id}`;
    return { duplicate: false };
  });
}

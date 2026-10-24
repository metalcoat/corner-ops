import { mxPresentment } from "@/lib/mx-presentment";
import { isoJson } from "@/lib/timestamp-values";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import {
  customerSessionHash,
  readCustomerOrderingSession,
} from "@/lib/customer-ordering-session";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import {
  checkoutState,
  commitTender,
  PaymentConflictError,
} from "@/lib/ordering-payments";
import {
  preflightDraftSubmit,
  submitDraftOrder,
  OrderConflictError,
} from "@/lib/ordering-order-lifecycle";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { sendCustomerOrderConfirmation } from "@/lib/customer-order-confirmation";
import {
  ensureMxPaymentSchema,
  findMxPaymentByReplayId,
  initializeMxPayment,
  MxMerchantError,
  newReplayId,
  retrieveMxPayment,
} from "@/lib/mx-merchant";
import { cardBillingContactForOrder } from "@/lib/card-billing-contact";
export const runtime = "nodejs";
const business = "Corner Deli" as const;
async function owned(request: Request, id: string) {
  const s = readCustomerOrderingSession(request);
  if (!s?.customerId || !s.authenticatedAt) return null;
  await ensureCustomerOrderingSchema();
  const hash = customerSessionHash(s.sessionId),
    row = (
      await getSql()`SELECT orders.id,orders.status,orders.source,orders.service_type FROM ordering_customer_web_carts carts JOIN ordering_orders orders ON orders.id=carts.order_id WHERE carts.order_id=${id} AND carts.session_hash=${hash} AND carts.replaced_at IS NULL LIMIT 1`
    )[0];
  return row ? { row, hash } : null;
}
type Actor = { id: string; name: string; type: "web" };
type CheckoutSession = Record<string, unknown>;

/** Records an MX approval for a checkout session, then sends the order to the kitchen. */
async function applyApprovedPayment(orderId: string, session: CheckoutSession, data: Record<string, unknown>, actor: Actor) {
  if (Math.round(Number(data.amount) * 100) !== Number(session.amount_cents))
    throw new MxMerchantError("Payment amount does not match the order.");
  const reference = String(data.id || data.reference || "");
  if (!reference) throw new MxMerchantError("MX Merchant did not return a payment reference.");
  const card = (data.cardAccount || {}) as Record<string, unknown>;
  const replayId = Number(session.replay_id);
  const payment = await commitTender({
    orderId,
    business,
    tenderType: "card",
    amountTenderedCents: Number(session.amount_cents),
    clientMutationId: String(session.client_mutation_id),
    actor,
    providerApproval: {
      provider: "mx_merchant",
      transactionReference: reference,
      brand: String(card.cardType || ""),
      last4: String(card.last4 || "").slice(-4),
      details: { replayId, channel: "online" },
    },
  });
  await getSql()`UPDATE ordering_mx_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=NOW()WHERE id=${String(session.id)}`;
  // The card is charged now. A send rule that fails here (it passed the
  // preflight at initialize, so something changed in between) must not look
  // like a failed payment: the customer is told it was charged and the order
  // stays on the POS alert list as a paid draft until staff send it.
  let order: Record<string, unknown> | null = null;
  try {
    order = (await submitDraftOrder(orderId, business, actor)).order as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof OrderConflictError)) throw error;
    console.error(`[online-checkout] order ${orderId} was paid but not sent: ${error.message}`);
    return { payment, order: null, sendError: error.message };
  }
  try {
    await dispatchSubmittedOrderPrintJobs(orderId, business);
  } catch (error) {
    // Print retries and the POS alert cover a failed first print attempt.
    console.error(`[online-checkout] first print attempt for order ${orderId} failed`, error);
  }
  after(() => sendCustomerOrderConfirmation(orderId).then(() => {}));
  return { payment, order, sendError: "" };
}

function paidButNotSent(message: string) {
  return isoJson(
    {
      error: `Your card was charged, but your order still needs a quick check by the store before it is made (${message}) The store has been alerted. Please don't pay again.`,
      paymentRecorded: true,
    },
    { status: 409 },
  );
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: orderId } = await params,
      owner = await owned(request, orderId);
    if (!owner) return unauthorized();
    const body = (await request.json()) as Record<string, unknown>,
      actor: Actor = {
        id: `web:${owner.hash.slice(0, 16)}`,
        name: "Online customer",
        type: "web",
      },
      sql = getSql();
    await ensureMxPaymentSchema();
    if (body.action === "initialize") {
      if (owner.row.status !== "draft")
        throw new MxMerchantError("This order is no longer awaiting payment.");
      // An earlier attempt may have been approved at MX while its confirm never
      // reached us (lost connection, timeout). Apply it instead of charging again.
      const earlier = await sql`SELECT * FROM ordering_mx_checkout_sessions WHERE order_id=${orderId} AND business=${business} AND status='initialized' AND created_at>NOW()-INTERVAL '6 hours' ORDER BY created_at DESC LIMIT 5`;
      for (const session of earlier) {
        let found: Record<string, unknown> | null;
        try {
          found = await findMxPaymentByReplayId(Number(session.replay_id));
        } catch {
          throw new MxMerchantError("We couldn't check on your earlier payment attempt. Please wait a minute and try again.");
        }
        if (!found || !String(found.status || "").toLowerCase().includes("approve")) continue;
        const applied = await applyApprovedPayment(orderId, session, found, actor);
        if (applied.sendError) return paidButNotSent(applied.sendError);
        return isoJson({ recovered: true, payment: applied.payment, order: applied.order }, { status: 201 });
      }
      // Run every send rule now, so hours, menu schedules or the delivery
      // minimum stop the customer before the card is charged.
      await preflightDraftSubmit(orderId, business, actor);
      const state = await checkoutState(orderId, business),
        amount = Number(state.order.amount_due_cents);
      if (amount <= 0)
        throw new PaymentConflictError("This order has no remaining balance.");
      const init = await initializeMxPayment(),
        replayId = newReplayId(),
        customer = await cardBillingContactForOrder(orderId, business);
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,expires_at)VALUES(${randomUUID()},${business},${orderId},${amount},${replayId},${randomUUID()},${actor.id},NOW()+INTERVAL '30 minutes')`;
      return isoJson({
        ...init,
        amount: amount / 100,
        replayId,
        customerName: customer?.contactName,
        avsStreet: customer?.street1,
        avsZip: customer?.postalCode,
        requireAvsZip: !customer?.postalCode,
        requireAvsStreet: !customer?.street1,
        ...mxPresentment("online"),
      });
    }
    if (body.action !== "confirm")
      throw new MxMerchantError("Unknown payment action.");
    const replayId = Number(body.replayId),
      session = (
        await sql`SELECT * FROM ordering_mx_checkout_sessions WHERE replay_id=${replayId} AND order_id=${orderId} LIMIT 1`
      )[0];
    if (!session || session.status !== "initialized")
      throw new MxMerchantError("This payment session expired.");
    const data = await retrieveMxPayment(replayId);
    const applied = await applyApprovedPayment(orderId, session, data, actor);
    if (applied.sendError) return paidButNotSent(applied.sendError);
    return isoJson({ payment: applied.payment, order: applied.order }, { status: 201 });
  } catch (e) {
    if (
      e instanceof MxMerchantError ||
      e instanceof PaymentConflictError ||
      e instanceof OrderConflictError
    )
      return isoJson({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

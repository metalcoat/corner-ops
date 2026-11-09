import { mxPresentment } from "@/lib/mx-presentment";
import { isoJson } from "@/lib/timestamp-values";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { getSql, withTransaction } from "@/lib/db";
import { apiError, RateLimitError, unauthorized } from "@/lib/http";
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
  syncDraftTotals,
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
  voidOrRefundMxPayment,
} from "@/lib/mx-merchant";
import { cardBillingContactForOrder } from "@/lib/card-billing-contact";
import { chargeSavedCard } from "@/lib/mx-saved-cards";
import { limitCardCheckoutStart } from "@/lib/customer-abuse-limits";
import { submitZeroBalanceCustomerOrder } from "@/lib/customer-zero-balance-checkout";
export const runtime = "nodejs";
const business = "Corner Deli" as const;
async function owned(request: Request, id: string) {
  // Card orders don't need a texted code or an account: the browser that built the cart pays.
  const s = readCustomerOrderingSession(request);
  if (!s) return null;
  await ensureCustomerOrderingSchema();
  const hash = customerSessionHash(s.sessionId),
    row = (
      await getSql()`SELECT orders.id,orders.status,orders.source,orders.service_type,carts.replaced_at FROM ordering_customer_web_carts carts JOIN ordering_orders orders ON orders.id=carts.order_id WHERE carts.order_id=${id} AND carts.session_hash=${hash} LIMIT 1`
    )[0];
  return row ? { row, hash } : null;
}
type Actor = { id: string; name: string; type: "web" };
type CheckoutSession = Record<string, unknown>;
const changedPaymentVoided = "Your order changed while you were paying, so we cancelled that charge. Please review the total and pay again.";
const changedPaymentNeedsReview = "Your order changed while you were paying. The store is checking the charge and its cancellation. Please don't pay again; call the store at (315) 393-2271.";
function paymentWasCharged(data: Record<string, unknown>) {
  // MX's original sale becomes Settled after batching; it is still a charge.
  return ["approved", "settled"].includes(String(data.status || "").trim().toLowerCase());
}

async function closeReconciledAttempt(session: CheckoutSession, data: Record<string, unknown>) {
  const status = String(data.status || "").trim().toLowerCase();
  const reference = String(data.id || data.reference || "");
  const amount = Math.round(Math.abs(Number(data.amount)) * 100);
  const refunded = Math.round(Math.abs(Number(data.refundedAmount || 0)) * 100);
  const reversed = Boolean(reference) && amount === Number(session.amount_cents)
    && (["void", "voided"].includes(status) || (amount > 0 && refunded >= amount));
  if (status !== "declined" && !reversed) return false;
  if (status === "declined" && !reference) return false;
  // A real MX decline is final for this replayId (MX returns the original
  // response on reuse). Distinguish it from a browser merely reporting decline.
  await withTransaction(async () => {
    const tx = getSql();
    await tx`SELECT id FROM ordering_orders WHERE id=${String(session.order_id)} FOR UPDATE`;
    const current = (await tx`SELECT status FROM ordering_mx_checkout_sessions WHERE id=${String(session.id)} FOR UPDATE`)[0];
    if (current?.status === "needs_review") throw new MxMerchantError(changedPaymentNeedsReview);
    await tx`UPDATE ordering_mx_checkout_sessions SET status=${reversed ? "voided" : "declined"},provider_transaction_reference=${reference},status_message=${reversed ? "MX confirmed the original charge was fully reversed." : "MX confirmed this replayId was declined."}
      WHERE id=${String(session.id)} AND status IN ('initialized','superseded','declined')`;
  });
  return true;
}

/** Records an MX approval for a checkout session, then sends the order to the kitchen. */
async function applyApprovedPayment(orderId: string, session: CheckoutSession, data: Record<string, unknown>, actor: Actor) {
  const reference = String(data.id || data.reference || "");
  if (!reference) throw new MxMerchantError("MX Merchant did not return a payment reference.");
  const card = (data.cardAccount || {}) as Record<string, unknown>;
  const replayId = Number(session.replay_id);
  // The order changed after this payment started (delivery address, reward, another
  // payment): never record a charge for the wrong amount. Cancel it at MX and ask
  // the customer to pay the current total.
  // Serialize recording against the order row. Two confirms may both have read
  // an initialized session, but the second must see the committed tender before
  // deciding that a zero balance means the approved charge should be voided.
  const recorded = await withTransaction(async () => {
    const tx = getSql();
    const order = (await tx`SELECT * FROM ordering_orders WHERE id=${orderId} AND business=${business} FOR UPDATE`)[0];
    if (!order) throw new MxMerchantError("Order was not found.");
    const duplicate = (await tx`SELECT id FROM ordering_payment_transactions WHERE business=${business} AND order_id=${orderId} AND client_mutation_id=${String(session.client_mutation_id)} AND transaction_type='payment' LIMIT 1`)[0];
    if (duplicate) return { payment: await checkoutState(orderId, business), order, duplicate: true };
    const current = (await tx`SELECT status FROM ordering_mx_checkout_sessions WHERE id=${String(session.id)} AND order_id=${orderId} FOR UPDATE`)[0];
    if (current?.status === "voided") throw new MxMerchantError(changedPaymentVoided);
    if (current?.status === "needs_review") throw new MxMerchantError(changedPaymentNeedsReview);
    if (!current || !["initialized", "superseded", "declined"].includes(String(current.status)))
      throw new MxMerchantError("This payment session expired.");
    if (Math.round(Number(data.amount) * 100) !== Number(session.amount_cents) || Math.abs(Number(data.refundedAmount || 0)) > 0) {
      // A partially refunded sale or unexpected processor amount cannot be
      // silently treated as unpaid, nor submitted as a full paid order.
      await tx`UPDATE ordering_mx_checkout_sessions SET status='needs_review',provider_transaction_reference=${reference},status_message='MX charge amount or refund does not match checkout. Check MX before retrying.' WHERE id=${String(session.id)}`;
      return "needs_review" as const;
    }
    const activeCart = (await tx`SELECT 1 FROM ordering_customer_web_carts WHERE order_id=${orderId} AND replaced_at IS NULL`)[0];
    if (!activeCart || Number(order.amount_due_cents) !== Number(session.amount_cents)) {
      // Claim the reversal durably before contacting MX. A concurrent confirm
      // must neither record this charge nor start another reversal. If this
      // request dies or MX fails, the charge remains visible for store review.
      await tx`UPDATE ordering_mx_checkout_sessions SET status='needs_review',provider_transaction_reference=${reference},status_message='Order changed during payment; reversal started. Check MX before retrying.' WHERE id=${String(session.id)}`;
      return null;
    }
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
    await tx`UPDATE ordering_mx_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=NOW()WHERE id=${String(session.id)}`;
    return { payment, order, duplicate: false };
  });
  if (recorded === "needs_review") throw new MxMerchantError(changedPaymentNeedsReview);
  if (!recorded) {
    try {
      await voidOrRefundMxPayment(reference);
    } catch (error) {
      console.error(`[online-checkout] order ${orderId}: MX payment ${reference} for a changed order could not be voided`, error);
      await getSql()`UPDATE ordering_mx_checkout_sessions SET status_message='Order changed during payment; void at MX failed. Check MX Merchant and refund if still charged.' WHERE id=${String(session.id)} AND status='needs_review' AND provider_transaction_reference=${reference}`;
      throw new MxMerchantError("Your order changed while you were paying. We couldn't cancel that charge automatically, so the store will refund it. Please call the store at (315) 393-2271.");
    }
    await getSql()`UPDATE ordering_mx_checkout_sessions SET status='voided',status_message='Order changed during payment; voided at MX.' WHERE id=${String(session.id)} AND status='needs_review' AND provider_transaction_reference=${reference}`;
    throw new MxMerchantError(changedPaymentVoided);
  }
  const { payment } = recorded;
  if (recorded.duplicate) {
    return {
      payment,
      order: recorded.order.status === "draft" ? null : recorded.order,
      sendError: recorded.order.status === "draft" ? "The paid order is still awaiting submission." : "",
    };
  }
  // The card is charged now. A send rule that fails here (it passed the
  // preflight at initialize, so something changed in between) must not look
  // like a failed payment: the customer is told it was charged and the order
  // stays on the POS alert list as a paid draft until staff send it.
  let order: Record<string, unknown> | null = null;
  try {
    order = (await submitDraftOrder(orderId, business, actor)).order as Record<string, unknown>;
  } catch (error) {
    // Any failure after the payment is recorded (a send rule, a loyalty change, a
    // database error) still tells the customer they were charged; the paid draft
    // stays on the POS online-order alert until staff send it.
    const message = error instanceof OrderConflictError ? error.message : "The order couldn't be sent automatically.";
    console.error(`[online-checkout] order ${orderId} was paid but not sent`, error);
    return { payment, order: null, sendError: message };
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
type PaymentRecovery = {
  unpaid: CheckoutSession[];
  reversed: boolean;
  sendError: string;
  error: unknown;
};

/** Finish every charge found before returning the order or allowing another token. */
async function reconcilePriorPayments(hash: string, actor: Actor, preferredId: string | null = null): Promise<PaymentRecovery> {
  const sql = getSql();
  const recovery: PaymentRecovery = { unpaid: [], reversed: false, sendError: "", error: null };
  if ((await sql`SELECT sessions.id FROM ordering_mx_checkout_sessions sessions JOIN ordering_customer_web_carts carts ON carts.order_id=sessions.order_id WHERE carts.session_hash=${hash} AND sessions.business=${business} AND sessions.status='needs_review' LIMIT 1`)[0])
    recovery.error = new MxMerchantError(changedPaymentNeedsReview);
  // Retrying, replacing the cart or expiring locally cannot revoke an old tab's
  // token. Recover all unresolved replayIds; a processor-confirmed decline is final.
  const earlier = await sql`SELECT sessions.* FROM ordering_mx_checkout_sessions sessions JOIN ordering_customer_web_carts carts ON carts.order_id=sessions.order_id WHERE carts.session_hash=${hash} AND sessions.business=${business}
    AND (sessions.status IN ('initialized','superseded') OR (sessions.status='declined' AND sessions.provider_transaction_reference=''))
    ORDER BY (sessions.id IS NOT DISTINCT FROM ${preferredId}::uuid) DESC,sessions.created_at DESC`;
  const recoveryDeadline = Date.now() + 12_000;
  for (let offset = 0; offset < earlier.length; offset += 4) {
    // Bound latency/concurrency, not which attempts are safe to ignore. Each
    // lookup also has a 12s timeout. Unchecked attempts always prevent a token.
    if (Date.now() >= recoveryDeadline) {
      recovery.error ||= new MxMerchantError("We need more time to check your earlier card attempts. Please try again in a minute or call the store; don't start another payment.");
      break;
    }
    const batch = earlier.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map((session) => findMxPaymentByReplayId(Number(session.replay_id))));
    for (let index = 0; index < batch.length; index++) {
      const session = batch[index], result = results[index];
      if (result.status === "rejected") {
        recovery.error ||= new MxMerchantError("We couldn't check on your earlier payment attempt. Please wait a minute and try again.");
        continue;
      }
      const found = result.value;
      if (!found) { recovery.unpaid.push(session); continue; }
      try {
        if (await closeReconciledAttempt(session, found)) continue;
        if (!paymentWasCharged(found))
          throw new MxMerchantError("Your earlier card payment is still being checked. Please wait a minute and try again, or call the store; don't start another payment.");
        const applied = await applyApprovedPayment(String(session.order_id), session, found, actor);
        if (applied.sendError) recovery.sendError = applied.sendError;
      } catch (error) {
        if (error instanceof MxMerchantError && error.message === changedPaymentVoided) recovery.reversed = true;
        else recovery.error ||= error;
      }
    }
  }
  return recovery;
}

async function recoveryResponse(orderId: string, recovery: PaymentRecovery, duplicate = false) {
  const order = (await getSql()`SELECT * FROM ordering_orders WHERE id=${orderId} AND business=${business}`)[0];
  const paymentRecorded = Number(order?.paid_cents) > 0;
  if (recovery.error) {
    if (paymentRecorded) return isoJson({
      error: "Your order payment was recorded, but an additional card attempt still needs checking. Please don't pay again; call the store at (315) 393-2271.",
      paymentRecorded: true,
    }, { status: 409 });
    throw recovery.error;
  }
  if (paymentRecorded && Number(order.amount_due_cents) === 0) {
    if (order.status === "draft") return paidButNotSent(recovery.sendError || "The paid order is still awaiting submission.");
    return isoJson({ order, recovered: true, duplicate, extraChargeReversed: recovery.reversed }, { status: 201 });
  }
  if (recovery.reversed) throw new MxMerchantError(changedPaymentVoided);
  if (!order || order.status !== "draft") throw new MxMerchantError("This order is no longer awaiting payment.");
  return null;
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
      // A replaced cart may confirm a charge so it can be reversed safely, but
      // can never obtain another token or become another kitchen order.
      if (owner.row.replaced_at) return unauthorized();
      const recovery = await reconcilePriorPayments(owner.hash, actor);
      const recovered = await recoveryResponse(orderId, recovery);
      if (recovered) return recovered;
      const unpaid = recovery.unpaid.filter((session) => String(session.order_id) === orderId);
      // Each start hands the browser a fresh MX token: limit them per visitor.
      await limitCardCheckoutStart(request, owner.hash);
      // Run every send rule now, so hours, menu schedules or the delivery
      // minimum stop the customer before the card is charged.
      await syncDraftTotals(orderId, business);
      await preflightDraftSubmit(orderId, business, actor);
      const state = await checkoutState(orderId, business),
        amount = Number(state.order.amount_due_cents);
      if (amount === 0 && Number(state.order.total_cents) === 0) {
        const submitted = await submitZeroBalanceCustomerOrder(orderId, actor);
        try { await dispatchSubmittedOrderPrintJobs(orderId, business); }
        catch (error) { console.error(`[online-checkout] first print attempt for covered order ${orderId} failed`, error); }
        after(() => sendCustomerOrderConfirmation(orderId).then(() => {}));
        return isoJson({ order: submitted.order, noPaymentRequired: true }, { status: 201 });
      }
      if (amount <= 0)
        throw new PaymentConflictError("This order has no remaining balance.");
      // One payment attempt per order: a second tab (or a reload) gets the same
      // replayId, and MX treats a repeat charge with it as the same payment
      // (verified in the MX sandbox, Oct 2026), so the customer can't be charged
      // twice. A new attempt starts only after a decline (retryAfterDecline) or
      // when the amount changed.
      const replayId = await withTransaction(async () => {
        const tx = getSql();
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`mx-online-checkout:${orderId}`}))`;
        const current = (await tx`SELECT orders.status,orders.amount_due_cents FROM ordering_orders orders
          JOIN ordering_customer_web_carts carts ON carts.order_id=orders.id
          WHERE orders.id=${orderId} AND orders.business=${business} AND carts.session_hash=${owner.hash} AND carts.replaced_at IS NULL FOR UPDATE OF orders,carts`)[0];
        // Preflight and the balance read preceded this lock. Another tab may
        // have submitted/paid the order or changed its rewards in the meantime.
        if (!current || current.status !== "draft")
          throw new MxMerchantError("This order is no longer awaiting payment.");
        if (Number(current.amount_due_cents) !== amount)
          throw new PaymentConflictError("The order total changed. Review the total before paying.");
        if ((await tx`SELECT sessions.id FROM ordering_mx_checkout_sessions sessions JOIN ordering_customer_web_carts carts ON carts.order_id=sessions.order_id WHERE carts.session_hash=${owner.hash} AND sessions.business=${business} AND sessions.status='needs_review' LIMIT 1`)[0])
          throw new MxMerchantError(changedPaymentNeedsReview);
        const open = (await tx`SELECT id,replay_id,amount_cents FROM ordering_mx_checkout_sessions WHERE order_id=${orderId} AND business=${business} AND status='initialized' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`)[0];
        const unpaidIds = unpaid.map((row) => String(row.id));
        if (open && Number(open.amount_cents) === amount && body.retryAfterDecline !== true) {
          await tx`UPDATE ordering_mx_checkout_sessions SET expires_at=NOW()+INTERVAL '30 minutes' WHERE id=${open.id}`;
          return Number(open.replay_id);
        }
        // Older attempts that MX shows no approved payment for are finished.
        if (unpaidIds.length) await tx`UPDATE ordering_mx_checkout_sessions SET status=${body.retryAfterDecline === true ? "declined" : "superseded"} WHERE id=ANY(${unpaidIds}::uuid[]) AND status='initialized'`;
        const fresh = newReplayId();
        await tx`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,expires_at)VALUES(${randomUUID()},${business},${orderId},${amount},${fresh},${randomUUID()},${actor.id},'online',NOW()+INTERVAL '30 minutes')`;
        return fresh;
      });
      if (body.savedCardId) {
        // Pay with a card saved on the signed-in customer's account: charged
        // server side on MX's vault token with this attempt's replayId (a retry
        // can't charge twice), then recorded and sent like a typed card.
        const session = (await sql`SELECT * FROM ordering_mx_checkout_sessions WHERE replay_id=${replayId} AND order_id=${orderId} LIMIT 1`)[0];
        const signedIn = readCustomerOrderingSession(request);
        const customerId = signedIn?.authenticatedAt ? signedIn.customerId : null;
        if (!session || !customerId) throw new MxMerchantError("Sign in to pay with a saved card.");
        const charged = await chargeSavedCard({ customerId, paymentMethodId: String(body.savedCardId), amountCents: amount, replayId, presentment: "online" });
        const applied = await applyApprovedPayment(orderId, session, charged, actor);
        const recovery = await reconcilePriorPayments(owner.hash, actor);
        recovery.sendError ||= applied.sendError;
        return (await recoveryResponse(orderId, recovery))!;
      }
      const init = await initializeMxPayment(),
        customer = await cardBillingContactForOrder(orderId, business);
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
    if (!session) throw new MxMerchantError("This payment session expired.");
    if (!["initialized", "superseded", "declined", "completed", "voided", "needs_review"].includes(String(session.status)))
      throw new MxMerchantError("This payment session expired.");
    // Confirm also reconciles other attempts, including on a completed order:
    // an expired tab may have charged a second replayId before either confirmed.
    const recovery = await reconcilePriorPayments(owner.hash, actor, String(session.id));
    const recovered = await recoveryResponse(orderId, recovery, session.status === "completed");
    if (recovered) return recovered;
    if (session.status === "voided") throw new MxMerchantError(changedPaymentVoided);
    throw new MxMerchantError("MX Merchant did not approve this payment.");

  } catch (e) {
    if (
      e instanceof RateLimitError
    )
      return isoJson({ error: "Too many payment attempts. Please wait an hour or call the store." }, { status: 429 });
    if (
      e instanceof MxMerchantError ||
      e instanceof PaymentConflictError ||
      e instanceof OrderConflictError
    )
      return isoJson({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

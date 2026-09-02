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
  submitDraftOrder,
  OrderConflictError,
} from "@/lib/ordering-order-lifecycle";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { sendCustomerOrderConfirmation } from "@/lib/customer-order-confirmation";
import {
  ensureMxPaymentSchema,
  initializeMxPayment,
  MxMerchantError,
  newReplayId,
  retrieveMxPayment,
} from "@/lib/mx-merchant";
import { helcimCustomerForOrder } from "@/lib/ordering-helcim-customer";
export const runtime = "nodejs";
const business = "Corner Deli" as const;
async function owned(request: Request, id: string) {
  const s = readCustomerOrderingSession(request);
  if (!s) return null;
  await ensureCustomerOrderingSchema();
  const hash = customerSessionHash(s.sessionId),
    row = (
      await getSql()`SELECT orders.id,orders.status,orders.source,orders.service_type FROM ordering_customer_web_carts carts JOIN ordering_orders orders ON orders.id=carts.order_id WHERE carts.order_id=${id} AND carts.session_hash=${hash} AND carts.replaced_at IS NULL LIMIT 1`
    )[0];
  return row ? { row, hash } : null;
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
      actor = {
        id: `web:${owner.hash.slice(0, 16)}`,
        name: "Online customer",
        type: "web" as const,
      },
      sql = getSql();
    if (body.action === "pay_later") {
      const submitted = await submitDraftOrder(orderId, business, actor);
      await dispatchSubmittedOrderPrintJobs(orderId, business);
      after(() => sendCustomerOrderConfirmation(orderId).then(() => {}));
      return Response.json({ order: submitted.order }, { status: 201 });
    }
    await ensureMxPaymentSchema();
    if (body.action === "initialize") {
      if (owner.row.status !== "draft")
        throw new MxMerchantError("This order is no longer awaiting payment.");
      const state = await checkoutState(orderId, business),
        amount = Number(state.order.amount_due_cents);
      if (amount <= 0)
        throw new PaymentConflictError("This order has no remaining balance.");
      const init = await initializeMxPayment(),
        replayId = newReplayId(),
        customer = await helcimCustomerForOrder(orderId, business);
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,expires_at)VALUES(${randomUUID()},${business},${orderId},${amount},${replayId},${randomUUID()},${actor.id},NOW()+INTERVAL '30 minutes')`;
      return Response.json({
        ...init,
        amount: amount / 100,
        replayId,
        customerName: customer?.contactName,
        avsStreet: customer?.billingAddress?.street1,
        avsZip: customer?.billingAddress?.postalCode,
        requireAvsZip: owner.row.service_type === "pickup",
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
    if (Math.round(Number(data.amount) * 100) !== Number(session.amount_cents))
      throw new MxMerchantError("Payment amount does not match the order.");
    const reference = String(data.id || data.reference || ""),
      card = (data.cardAccount || {}) as Record<string, unknown>;
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
    await sql`UPDATE ordering_mx_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=NOW()WHERE id=${session.id}`;
    const submitted = await submitDraftOrder(orderId, business, actor);
    await dispatchSubmittedOrderPrintJobs(orderId, business);
    after(() => sendCustomerOrderConfirmation(orderId).then(() => {}));
    return Response.json({ payment, order: submitted.order }, { status: 201 });
  } catch (e) {
    if (
      e instanceof MxMerchantError ||
      e instanceof PaymentConflictError ||
      e instanceof OrderConflictError
    )
      return Response.json({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

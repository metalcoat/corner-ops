import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import {
  assertOrderReadyForCheckout,
  checkoutState,
  commitTender,
  PaymentConflictError,
} from "@/lib/ordering-payments";
import { orderingActor } from "@/lib/ordering-route-auth";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { submitDraftOrder } from "@/lib/ordering-order-lifecycle";
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
export async function GET() {
  try {
    if (!(await orderingActor(business))) return unauthorized();
    return Response.json({
      checkoutEnabled:
        process.env.MX_ENVIRONMENT === "sandbox" ||
        Boolean(process.env.MX_CONSUMER_KEY),
      sandbox: process.env.MX_ENVIRONMENT !== "production",
    });
  } catch (e) {
    return apiError(e);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const { id: orderId } = await params,
      body = (await request.json()) as Record<string, unknown>,
      sql = getSql();
    await ensureMxPaymentSchema();
    if (body.action === "initialize") {
      await assertOrderReadyForCheckout(orderId, business);
      const checkId = body.checkId ? String(body.checkId) : null,
        state = await checkoutState(orderId, business, checkId),
        remaining = Number(
          state.check?.amount_due_cents ?? state.order.amount_due_cents,
        ),
        amount =
          body.amountCents == null
            ? remaining
            : Math.trunc(Number(body.amountCents));
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining)
        throw new PaymentConflictError(
          "Enter a card amount within the remaining balance.",
        );
      const initialized = await initializeMxPayment(),
        replayId = newReplayId(),
        customer = await helcimCustomerForOrder(orderId, business);
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,check_id,amount_cents,replay_id,client_mutation_id,created_by,expires_at)VALUES(${randomUUID()},${business},${orderId},${checkId},${amount},${replayId},${randomUUID()},${actor.id},NOW()+INTERVAL '30 minutes')`;
      return Response.json({
        ...initialized,
        amount: amount / 100,
        replayId,
        customerName: customer?.contactName,
        avsStreet: customer?.billingAddress?.street1,
        avsZip: customer?.billingAddress?.postalCode || "13669",
        requireAvsZip: true,
      });
    }
    if (body.action !== "confirm")
      throw new MxMerchantError("Unknown MX payment action.");
    const replayId = Number(body.replayId),
      session = (
        await sql`SELECT * FROM ordering_mx_checkout_sessions WHERE replay_id=${replayId} AND order_id=${orderId} AND business=${business} LIMIT 1`
      )[0];
    if (
      !session ||
      session.status !== "initialized" ||
      new Date(session.expires_at).getTime() < Date.now()
    )
      throw new MxMerchantError("This MX payment session expired.");
    const data = await retrieveMxPayment(replayId);
    if (Math.round(Number(data.amount) * 100) !== Number(session.amount_cents))
      throw new MxMerchantError(
        "The MX approval amount does not match this order.",
      );
    const reference = String(data.id || data.reference || "");
    if (!reference)
      throw new MxMerchantError("MX did not return a transaction reference.");
    const card =
      data.cardAccount && typeof data.cardAccount === "object"
        ? (data.cardAccount as Record<string, unknown>)
        : {};
    const result = await commitTender({
      orderId,
      business,
      tenderType: "card",
      amountTenderedCents: Number(session.amount_cents),
      clientMutationId: String(session.client_mutation_id),
      checkId: session.check_id || null,
      actor,
      providerApproval: {
        provider: "mx_merchant",
        transactionReference: reference,
        brand: String(card.cardType || ""),
        last4: String(card.last4 || "")
          .replace(/\D/g, "")
          .slice(-4),
        details: { replayId, channel: "pos_keyed" },
      },
    });
    await sql`UPDATE ordering_mx_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=NOW() WHERE id=${session.id}`;
    if (result.order.payment_status === "paid" && result.order.status === "draft") {
      await submitDraftOrder(orderId, business, actor);
      await dispatchSubmittedOrderPrintJobs(orderId, business);
    } else {
      await dispatchOrderPrintJobs(orderId, business, {
        includeKitchenProduction: false,
      });
    }
    return Response.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof MxMerchantError || e instanceof PaymentConflictError)
      return Response.json({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import {
  HelcimError,
  initializeHelcimPay,
  safeEqual,
  sha256,
  validateHelcimPayResponse,
} from "@/lib/helcim";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import {
  customerSessionHash,
  readCustomerOrderingSession,
} from "@/lib/customer-ordering-session";
import { ensureOrderingHelcimSchema } from "@/lib/ordering-helcim-schema";
import {
  checkoutState,
  commitTender,
  PaymentConflictError,
} from "@/lib/ordering-payments";
import {
  submitDraftOrder,
  OrderConflictError,
} from "@/lib/ordering-order-lifecycle";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { sendCustomerOrderConfirmation } from "@/lib/customer-order-confirmation";
import { after } from "next/server";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

async function ownedCart(request: Request, orderId: string) {
  const session = readCustomerOrderingSession(request);
  if (!session) return null;
  await ensureCustomerOrderingSchema();
  const hash = customerSessionHash(session.sessionId),
    sql = getSql();
  const row = (
    await sql`SELECT orders.id,orders.status,orders.source,orders.service_type FROM ordering_customer_web_carts carts JOIN ordering_orders orders ON orders.id=carts.order_id WHERE carts.order_id=${orderId} AND carts.session_hash=${hash} AND carts.replaced_at IS NULL LIMIT 1`
  )[0];
  return row ? { row, hash } : null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: orderId } = await context.params;
    const owner = await ownedCart(request, orderId);
    if (!owner) return unauthorized();
    if (owner.row.source !== "web" || owner.row.service_type !== "pickup")
      throw new HelcimError(
        "Online Helcim testing is currently available for pickup orders.",
      );
    const body = (await request.json()) as Record<string, unknown>;
    const actor = {
      id: `web:${owner.hash.slice(0, 16)}`,
      name: "Online customer",
      type: "web" as const,
    };
    if (body.action === "pay_later") {
      if (owner.row.status !== "draft")
        throw new OrderConflictError(
          "This order is no longer awaiting submission.",
        );
      const submitted = await submitDraftOrder(orderId, business, actor);
      await dispatchSubmittedOrderPrintJobs(orderId, business);
      after(async () => {
        await sendCustomerOrderConfirmation(orderId);
      });
      return Response.json(
        { order: submitted.order, paymentStatus: "unpaid", payAtPickup: true },
        { status: 201 },
      );
    }
    await ensureOrderingHelcimSchema();
    const sql = getSql();
    if (body.action === "initialize") {
      if (owner.row.status !== "draft")
        throw new HelcimError(
          "This online order is no longer awaiting payment.",
        );
      const recent =
        await sql`SELECT COUNT(*)::integer count FROM ordering_helcim_checkout_sessions WHERE order_id=${orderId} AND created_at>NOW()-INTERVAL '10 minutes'`;
      if (Number(recent[0]?.count || 0) >= 5)
        throw new HelcimError(
          "Too many checkout attempts. Wait ten minutes before trying again.",
        );
      const state = await checkoutState(orderId, business);
      const amountCents = Number(state.order.amount_due_cents);
      if (amountCents <= 0)
        throw new PaymentConflictError("This order has no remaining balance.");
      const initialized = await initializeHelcimPay(amountCents);
      const id = randomUUID(),
        mutationId = randomUUID();
      await sql`INSERT INTO ordering_helcim_checkout_sessions(id,business,order_id,amount_cents,checkout_token,secret_hash,client_mutation_id,created_by,expires_at) VALUES(${id},${business},${orderId},${amountCents},${initialized.checkoutToken},${sha256(initialized.secretToken)},${mutationId},${`web:${owner.hash.slice(0, 16)}`},NOW()+INTERVAL '60 minutes')`;
      return Response.json(initialized);
    }
    if (body.action !== "confirm")
      throw new HelcimError("Unknown Helcim action.");
    const checkoutToken = String(body.checkoutToken || ""),
      secretToken = String(body.secretToken || "");
    const session = (
      await sql`SELECT * FROM ordering_helcim_checkout_sessions WHERE checkout_token=${checkoutToken} AND order_id=${orderId} AND business=${business} LIMIT 1`
    )[0];
    if (
      !session ||
      session.status === "expired" ||
      new Date(session.expires_at).getTime() < Date.now()
    )
      throw new HelcimError("This Helcim checkout session expired.");
    if (!safeEqual(String(session.secret_hash), sha256(secretToken)))
      throw new HelcimError("Helcim checkout verification failed.");
    const data = validateHelcimPayResponse(
      body.data,
      String(body.hash || ""),
      secretToken,
    );
    const status = String(data.status || "").toLowerCase();
    if (!status.includes("approve"))
      throw new HelcimError("Helcim did not approve this payment.");
    if (String(data.type || "").toLowerCase() !== "purchase")
      throw new HelcimError("Helcim returned the wrong transaction type.");
    if (
      Math.round(Number(data.amount) * 100) !== Number(session.amount_cents) ||
      String(data.currency || "").toUpperCase() !== "USD"
    )
      throw new HelcimError(
        "The Helcim approval does not match this order balance.",
      );
    const reference = String(data.transactionId || "");
    if (!reference)
      throw new HelcimError("Helcim did not return a transaction reference.");
    const digits = String(data.cardNumber || "").replace(/\D/g, "");
    const payment = await commitTender({
      orderId,
      business,
      tenderType: "card",
      amountTenderedCents: Number(session.amount_cents),
      clientMutationId: String(session.client_mutation_id),
      actor,
      providerApproval: {
        provider: "helcim",
        transactionReference: reference,
        brand: String(data.cardType || "").slice(0, 40),
        last4: digits.slice(-4),
        details: { helcimCheckoutToken: checkoutToken, channel: "online" },
      },
    });
    await sql`UPDATE ordering_helcim_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=NOW() WHERE id=${session.id}`;
    await dispatchOrderPrintJobs(orderId, business, {
      includeKitchenProduction: false,
    });
    try {
      const submitted = await submitDraftOrder(orderId, business, actor);
      await dispatchSubmittedOrderPrintJobs(orderId, business);
      after(async () => {
        const email = await sendCustomerOrderConfirmation(orderId);
        if (email.failures.length)
          console.error("[customer-order] confirmation email failed", {
            orderId,
            failures: email.failures,
          });
      });
      return Response.json(
        {
          payment,
          order: submitted.order,
          confirmationEmail: { queued: true },
          alreadySubmitted: submitted.alreadySubmitted,
        },
        { status: 201 },
      );
    } catch (error) {
      if (!(error instanceof OrderConflictError)) throw error;
      const order = (
        await sql`SELECT display_number,payment_status,status FROM ordering_orders WHERE id=${orderId}`
      )[0];
      return Response.json(
        {
          payment,
          order,
          paid: true,
          needsAssistance: true,
          submissionError: error.message,
        },
        { status: 202 },
      );
    }
  } catch (error) {
    if (
      error instanceof HelcimError ||
      error instanceof PaymentConflictError ||
      error instanceof OrderConflictError
    )
      return Response.json(
        { error: error.message.replaceAll("Helcim", "secure payment") },
        { status: 409 },
      );
    return apiError(error);
  }
}

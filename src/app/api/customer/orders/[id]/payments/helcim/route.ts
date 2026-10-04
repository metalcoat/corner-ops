import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import {
  HelcimError,
  initializeHelcimPay,
  sha256,
} from "@/lib/helcim";
import { verifyHelcimCheckoutApproval } from "@/lib/ordering-helcim-verify";
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
import { helcimCustomerForOrder } from "@/lib/ordering-helcim-customer";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

async function ownedCart(request: Request, orderId: string) {
  const session = readCustomerOrderingSession(request);
  if (!session?.customerId || !session.authenticatedAt) return null;
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
    if (
      owner.row.source !== "web" ||
      !["pickup", "delivery"].includes(String(owner.row.service_type))
    )
      throw new HelcimError(
        "Online secure payment is unavailable for this order.",
      );
    if (owner.row.service_type === "delivery") {
      const address = (
        await getSql()`SELECT 1 FROM ordering_order_delivery_addresses WHERE order_id=${orderId} AND validation_status='validated' LIMIT 1`
      )[0];
      if (!address)
        throw new HelcimError("Validate the delivery address before payment.");
    }
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
        { order: submitted.order, paymentStatus: "unpaid", payLater: true },
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
      const initialized = await initializeHelcimPay(amountCents, await helcimCustomerForOrder(orderId, business));
      const id = randomUUID(),
        mutationId = randomUUID();
      await sql`INSERT INTO ordering_helcim_checkout_sessions(id,business,order_id,amount_cents,checkout_token,secret_hash,secret_token,client_mutation_id,created_by,expires_at) VALUES(${id},${business},${orderId},${amountCents},${initialized.checkoutToken},${sha256(initialized.secretToken)},${initialized.secretToken},${mutationId},${`web:${owner.hash.slice(0, 16)}`},NOW()+INTERVAL '60 minutes')`;
      // Never hand the secret token to the browser.
      return Response.json({ checkoutToken: initialized.checkoutToken });
    }
    if (body.action !== "confirm")
      throw new HelcimError("Unknown Helcim action.");
    const checkoutToken = String(body.checkoutToken || "");
    const session = (
      await sql`SELECT * FROM ordering_helcim_checkout_sessions WHERE checkout_token=${checkoutToken} AND order_id=${orderId} AND business=${business} LIMIT 1`
    )[0];
    if (
      !session ||
      session.status === "expired" ||
      new Date(session.expires_at).getTime() < Date.now()
    )
      throw new HelcimError("This Helcim checkout session expired.");
    const approval = await verifyHelcimCheckoutApproval({
      session: session as never,
      data: body.data,
      hash: String(body.hash || ""),
      legacyClientSecret: body.secretToken ? String(body.secretToken) : undefined,
    });
    const reference = approval.reference;
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
        brand: approval.brand,
        last4: approval.last4,
        details: { helcimCheckoutToken: checkoutToken, channel: "online" },
      },
    });
    await sql`UPDATE ordering_helcim_checkout_sessions SET status='completed',provider_transaction_reference=${reference},secret_token=NULL,completed_at=NOW() WHERE id=${session.id}`;
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

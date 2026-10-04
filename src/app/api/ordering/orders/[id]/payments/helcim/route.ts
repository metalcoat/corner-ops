import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import {
  HelcimError,
  helcimStatus,
  initializeHelcimPay,
  sha256,
  testHelcimConnection,
} from "@/lib/helcim";
import { verifyHelcimCheckoutApproval } from "@/lib/ordering-helcim-verify";
import { ensureOrderingHelcimSchema } from "@/lib/ordering-helcim-schema";
import {
  assertOrderReadyForCheckout,
  checkoutState,
  commitTender,
  PaymentConflictError,
} from "@/lib/ordering-payments";
import { orderingActor } from "@/lib/ordering-route-auth";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { helcimCustomerForOrder } from "@/lib/ordering-helcim-customer";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

export async function GET(_request: Request) {
  try {
    if (!(await orderingActor(business))) return unauthorized();
    return Response.json({ ...helcimStatus(), localDevelopment: process.env.LOCAL_DEVELOPMENT === "true" });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "test")
      return Response.json(await testHelcimConnection());
    const { id: orderId } = await context.params;
    await ensureOrderingHelcimSchema();
    const sql = getSql();
    if (body.action === "initialize") {
      await assertOrderReadyForCheckout(orderId, business);
      const checkId = body.checkId ? String(body.checkId) : null;
      const state = await checkoutState(orderId, business, checkId);
      const remainingCents = Number(
        state.check?.amount_due_cents ?? state.order.amount_due_cents,
      );
      const amountCents = body.amountCents == null ? remainingCents : Math.trunc(Number(body.amountCents));
      if (amountCents <= 0)
        throw new PaymentConflictError("This order has no remaining balance.");
      if (!Number.isSafeInteger(amountCents) || amountCents > remainingCents)
        throw new PaymentConflictError("Card amount must not exceed the remaining balance.");
      const initialized = await initializeHelcimPay(amountCents, await helcimCustomerForOrder(orderId, business));
      const sessionId = randomUUID(),
        clientMutationId = randomUUID();
      await sql`INSERT INTO ordering_helcim_checkout_sessions(id,business,order_id,check_id,amount_cents,checkout_token,secret_hash,secret_token,client_mutation_id,created_by,expires_at)
        VALUES(${sessionId},${business},${orderId},${checkId},${amountCents},${initialized.checkoutToken},${sha256(initialized.secretToken)},${initialized.secretToken},${clientMutationId},${actor.id},NOW()+INTERVAL '60 minutes')`;
      // The secret token never leaves the server; the browser only needs the
      // checkout token to open the HelcimPay.js iframe.
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
    const result = await commitTender({
      orderId,
      business,
      tenderType: "card",
      amountTenderedCents: Number(session.amount_cents),
      clientMutationId: String(session.client_mutation_id),
      checkId: session.check_id || null,
      actor,
      providerApproval: {
        provider: "helcim",
        transactionReference: reference,
        brand: approval.brand,
        last4: approval.last4,
        details: {
          helcimCheckoutToken: checkoutToken,
          helcimApprovalCode: approval.approvalCode,
        },
      },
    });
    await sql`UPDATE ordering_helcim_checkout_sessions SET status='completed',provider_transaction_reference=${reference},secret_token=NULL,completed_at=NOW() WHERE id=${session.id}`;
    await dispatchOrderPrintJobs(orderId, business, {
      includeKitchenProduction: false,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof HelcimError || error instanceof PaymentConflictError)
      return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}

import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import {
  HelcimError,
  helcimStatus,
  initializeHelcimPay,
  safeEqual,
  sha256,
  testHelcimConnection,
  validateHelcimPayResponse,
} from "@/lib/helcim";
import { ensureOrderingHelcimSchema } from "@/lib/ordering-helcim-schema";
import {
  checkoutState,
  commitTender,
  PaymentConflictError,
} from "@/lib/ordering-payments";
import { orderingActor } from "@/lib/ordering-route-auth";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

export async function GET(_request: Request) {
  try {
    if (!(await orderingActor(business))) return unauthorized();
    return Response.json(helcimStatus());
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
      const initialized = await initializeHelcimPay(amountCents);
      const sessionId = randomUUID(),
        clientMutationId = randomUUID();
      await sql`INSERT INTO ordering_helcim_checkout_sessions(id,business,order_id,check_id,amount_cents,checkout_token,secret_hash,client_mutation_id,created_by,expires_at)
        VALUES(${sessionId},${business},${orderId},${checkId},${amountCents},${initialized.checkoutToken},${sha256(initialized.secretToken)},${clientMutationId},${actor.id},NOW()+INTERVAL '60 minutes')`;
      return Response.json({
        checkoutToken: initialized.checkoutToken,
        secretToken: initialized.secretToken,
      });
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
    const approved = String(
      data.status || data.approvalStatus || "",
    ).toLowerCase();
    if (!approved.includes("approve") && approved !== "success")
      throw new HelcimError("Helcim did not approve this payment.");
    if (String(data.type || "").toLowerCase() !== "purchase")
      throw new HelcimError("Helcim returned the wrong transaction type.");
    const reference = String(data.transactionId || data.id || "");
    if (!reference)
      throw new HelcimError("Helcim did not return a transaction reference.");
    const responseAmountCents = Math.round(Number(data.amount) * 100);
    if (
      responseAmountCents !== Number(session.amount_cents) ||
      String(data.currency || "").toUpperCase() !== "USD"
    )
      throw new HelcimError(
        "The Helcim approval does not match this order balance.",
      );
    const cardDigits = String(
      data.cardNumber || data.cardNumberMasked || data.lastFour || "",
    ).replace(/\D/g, "");
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
        brand: String(data.cardType || data.cardBrand || "").slice(0, 40),
        last4: cardDigits.slice(-4),
        details: {
          helcimCheckoutToken: checkoutToken,
          helcimApprovalCode: String(data.approvalCode || "").slice(0, 80),
        },
      },
    });
    await sql`UPDATE ordering_helcim_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=NOW() WHERE id=${session.id}`;
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

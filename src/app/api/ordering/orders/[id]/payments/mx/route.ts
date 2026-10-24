import { mxPresentment } from "@/lib/mx-presentment";
import { isoJson } from "@/lib/timestamp-values";
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
import { submitPaidDraft } from "@/lib/ordering-paid-draft-submit";
import {
  ensureMxPaymentSchema,
  initializeMxPayment,
  MxMerchantError,
  newReplayId,
  retrieveMxPayment,
} from "@/lib/mx-merchant";
import { cardBillingContactForOrder } from "@/lib/card-billing-contact";
import { chargeSavedCard, listSavedCards, startCardSave, syncSavedCards } from "@/lib/mx-saved-cards";
import { paymentProviderStatus } from "@/lib/payment-provider";
export const runtime = "nodejs";
import { settleOpenTerminalSales, TerminalSaleRecordedError } from "@/lib/mx-terminal-payments";
const business = "Corner Deli" as const;
export async function GET() {
  try {
    if (!(await orderingActor(business))) return unauthorized();
    const status = paymentProviderStatus();
    return isoJson({ checkoutEnabled: status.onlineCheckoutEnabled, sandbox: status.sandbox });
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
      // A terminal sale on this order may still charge the card; settle it before keying another card.
      await settleOpenTerminalSales({ business, orderId, actor });
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
      const orderCustomerId = (await sql`SELECT customer_id FROM ordering_orders WHERE id=${orderId} AND business=${business}`)[0]?.customer_id as string | null;
      const initialized = await initializeMxPayment(),
        replayId = newReplayId(),
        customer = await cardBillingContactForOrder(orderId, business);
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,check_id,amount_cents,replay_id,client_mutation_id,created_by,expires_at)VALUES(${randomUUID()},${business},${orderId},${checkId},${amount},${replayId},${randomUUID()},${actor.id},NOW()+INTERVAL '30 minutes')`;
      return isoJson({
        ...initialized,
        amount: amount / 100,
        replayId,
        customerName: customer?.contactName,
        avsStreet: customer?.street1,
        avsZip: customer?.postalCode || "13669",
        requireAvsZip: false,
        requireAvsStreet: !customer?.street1,
        // Card-present payments go through the reader; a card keyed on the POS was read over the phone.
        ...mxPresentment("phone"),
        // Cards the attached customer saved; staff charge one only with the customer's OK on the call.
        savedCards: orderCustomerId ? await listSavedCards(orderCustomerId) : [],
        canSaveCard: Boolean(orderCustomerId),
      });
    }
    if (body.action === "save_card_start" || body.action === "save_card_saved") {
      // Saving the keyed card for the attached customer, who agreed on the call.
      // The dialog sends the card straight to MX's vault; we only record MX's token.
      const customerId = (await sql`SELECT customer_id FROM ordering_orders WHERE id=${orderId} AND business=${business}`)[0]?.customer_id;
      if (!customerId) throw new MxMerchantError("Attach a customer to save their card.");
      if (body.action === "save_card_start") return isoJson(await startCardSave(String(customerId)));
      return isoJson({ cards: await syncSavedCards(String(customerId), `staff:${actor.id}:phone_consent`) });
    }
    if (body.action !== "confirm" && body.action !== "charge_saved_card")
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
    let data: Record<string, unknown>;
    if (body.action === "charge_saved_card") {
      // Phone order: the customer said OK to charging their saved card.
      if (body.customerConsented !== true) throw new MxMerchantError("Confirm the customer agreed to use their saved card.");
      const customerId = (await sql`SELECT customer_id FROM ordering_orders WHERE id=${orderId} AND business=${business}`)[0]?.customer_id;
      if (!customerId) throw new MxMerchantError("Attach the customer to use their saved card.");
      data = await chargeSavedCard({ customerId: String(customerId), paymentMethodId: String(body.savedCardId || ""), amountCents: Number(session.amount_cents), replayId });
    } else data = await retrieveMxPayment(replayId);
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
        details: { replayId, channel: body.action === "charge_saved_card" ? "pos_saved_card" : "pos_keyed" },
      },
    });
    await sql`UPDATE ordering_mx_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=NOW() WHERE id=${session.id}`;
    if (
      result.order.payment_status === "paid" &&
      result.order.status === "draft"
    ) {
      const unsent = await submitPaidDraft(orderId, business, actor);
      if (unsent) return unsent;
      await dispatchSubmittedOrderPrintJobs(orderId, business);
    } else {
      await dispatchOrderPrintJobs(orderId, business, {
        includeKitchenProduction: false,
      });
    }
    return isoJson(result, { status: 201 });
  } catch (e) {
    if (e instanceof TerminalSaleRecordedError) return isoJson({ error: e.message, checkout: e.checkout }, { status: 409 });
    if (e instanceof MxMerchantError || e instanceof PaymentConflictError)
      return isoJson({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

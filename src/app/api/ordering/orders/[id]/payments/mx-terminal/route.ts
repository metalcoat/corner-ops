import { apiError, unauthorized } from "@/lib/http";
import { PaymentConflictError } from "@/lib/ordering-payments";
import { orderingActor } from "@/lib/ordering-route-auth";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { submitPaidDraft } from "@/lib/ordering-paid-draft-submit";
import { MxMerchantError } from "@/lib/mx-merchant";
import {
  abandonTerminalPayment,
  checkTerminalPayment,
  startTerminalPayment,
  type TerminalPaymentOutcome,
} from "@/lib/mx-terminal-payments";
export const runtime = "nodejs";
const business = "Corner Deli" as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const { id: orderId } = await params,
      body = (await request.json()) as Record<string, unknown>;
    if (body.action === "abandon") {
      await abandonTerminalPayment({ business, orderId, sessionId: String(body.sessionId || "") });
      return Response.json({ ok: true });
    }
    let outcome: TerminalPaymentOutcome;
    if (body.action === "start")
      outcome = await startTerminalPayment({
        business,
        orderId,
        actor,
        checkId: body.checkId ? String(body.checkId) : null,
        amountCents: body.amountCents == null ? null : Number(body.amountCents),
        stationKey: String(body.stationKey || ""),
      });
    else if (body.action === "status")
      outcome = await checkTerminalPayment({ business, orderId, actor, sessionId: String(body.sessionId || "") });
    else throw new MxMerchantError("Unknown terminal payment action.");
    if (outcome.state !== "approved") return Response.json(outcome);
    // Same follow-up as a keyed MX approval, once per recorded tender.
    if (!outcome.checkout.duplicate) {
      if (outcome.checkout.order.payment_status === "paid" && outcome.checkout.order.status === "draft") {
        const unsent = await submitPaidDraft(orderId, business, actor);
        if (unsent) return unsent;
        await dispatchSubmittedOrderPrintJobs(orderId, business);
      } else {
        await dispatchOrderPrintJobs(orderId, business, { includeKitchenProduction: false });
      }
    }
    return Response.json(outcome, { status: 201 });
  } catch (e) {
    if (e instanceof MxMerchantError || e instanceof PaymentConflictError)
      return Response.json({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

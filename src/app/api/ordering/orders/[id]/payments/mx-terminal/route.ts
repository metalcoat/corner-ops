import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { PaymentConflictError } from "@/lib/ordering-payments";
import { orderingActor } from "@/lib/ordering-route-auth";
import { MxMerchantError } from "@/lib/mx-merchant";
import {
  abandonTerminalPayment,
  checkTerminalPayment,
  completeTerminalPayment,
  finishTerminalApproval,
  startTerminalPayment,
  type TerminalPaymentOutcome,
  voidTerminalAuthorization,
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
      return isoJson({ ok: true });
    }
    if (body.action === "void") {
      await voidTerminalAuthorization({ business, orderId, sessionId: String(body.sessionId || "") });
      return isoJson({ ok: true });
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
    // The customer chose a tip after the card was approved (0 for none).
    else if (body.action === "complete")
      outcome = await completeTerminalPayment({ business, orderId, actor, sessionId: String(body.sessionId || ""), tipCents: Math.round(Number(body.tipCents)) });
    else throw new MxMerchantError("Unknown terminal payment action.");
    // Pending, authorized (ask for the tip), declined, failed, and needs_review are all normal answers; the dialog decides what to show.
    if (outcome.state !== "approved") return isoJson(outcome);
    return isoJson(await finishTerminalApproval(outcome, orderId, business, actor), { status: 201 });
  } catch (e) {
    if (e instanceof MxMerchantError || e instanceof PaymentConflictError)
      return isoJson({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

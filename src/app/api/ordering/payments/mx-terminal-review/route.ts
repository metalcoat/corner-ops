import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { PaymentConflictError } from "@/lib/ordering-payments";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { listTerminalSalesNeedingReview, resolveTerminalSaleReview } from "@/lib/mx-terminal-payments";
import { listWebPaymentsNeedingReview, resolveWebPaymentReview } from "@/lib/customer-payment-review";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

async function reviews() {
  const [terminal, web] = await Promise.all([listTerminalSalesNeedingReview(business), listWebPaymentsNeedingReview(business)]);
  return [...terminal.map((sale) => ({ ...sale, review_kind: "terminal" })), ...web];
}

/** Card charges that require a manager's review. */
export async function GET() {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    if (!canManagePos(actor)) return isoJson({ sales: [] });
    return isoJson({ sales: await reviews() });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const body = (await request.json()) as Record<string, unknown>;
    const input = { business, sessionId: String(body.sessionId || ""), note: String(body.note || ""), actor };
    if (body.reviewKind === "web") await resolveWebPaymentReview(input);
    else if (body.reviewKind === undefined || body.reviewKind === "terminal") await resolveTerminalSaleReview(input);
    else throw new PaymentConflictError("Unknown payment review type.");
    return isoJson({ sales: await reviews() });
  } catch (e) {
    if (e instanceof PaymentConflictError) return isoJson({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

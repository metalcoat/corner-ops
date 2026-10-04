import { apiError, unauthorized } from "@/lib/http";
import { PaymentConflictError } from "@/lib/ordering-payments";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { listTerminalSalesNeedingReview, resolveTerminalSaleReview } from "@/lib/mx-terminal-payments";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

/** Terminal charges the POS could not put on an order. */
export async function GET() {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    if (!canManagePos(actor)) return Response.json({ sales: [] });
    return Response.json({ sales: await listTerminalSalesNeedingReview(business) });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const body = (await request.json()) as Record<string, unknown>;
    await resolveTerminalSaleReview({ business, sessionId: String(body.sessionId || ""), note: String(body.note || ""), actor });
    return Response.json({ sales: await listTerminalSalesNeedingReview(business) });
  } catch (e) {
    if (e instanceof PaymentConflictError) return Response.json({ error: e.message }, { status: 409 });
    return apiError(e);
  }
}

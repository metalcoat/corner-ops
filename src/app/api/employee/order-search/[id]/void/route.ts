import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { pinAttemptKeys } from "@/lib/pos-access-guard";
import { OrderVoidError } from "@/lib/ordering-voids";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { orderSearchDetail } from "@/lib/ordering-order-search";
import { portalManager, PortalMoneyError, portalVoidOrder } from "@/lib/manager-portal-refunds";

export const runtime = "nodejs";

/** Manager portal void: the whole order, then its payments back to where they came from or as store credit. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const orderId = (await context.params).id;
    const body = await request.json() as Record<string, unknown>;
    const clientMutationId = String(body.clientMutationId || "").slice(0, 120);
    if (!clientMutationId) throw new PortalMoneyError("Missing request ID. Reload and try again.", 400);
    const actor = await portalManager(body.pin, pinAttemptKeys(request.headers));
    const refund = body.refund === "store_credit" ? "store_credit" : body.refund === "none" ? "none" : "original";
    const result = await portalVoidOrder({ orderId, reason: body.reason, refund, clientMutationId: `portal-void:${clientMutationId}`, actor });
    // Same as the POS: the kitchen gets a void notice. A printer problem must not read as a failed void.
    try { await dispatchSubmittedOrderPrintJobs(orderId, "Corner Deli"); } catch (error) { console.error("[portal-void] notice print failed", error); }
    return isoJson({ result, order: await orderSearchDetail(orderId) }, { status: 201 });
  } catch (error) {
    if (error instanceof PortalMoneyError) return isoJson({ error: error.message }, { status: error.status });
    if (error instanceof OrderVoidError) return isoJson({ error: error.message }, { status: 409 });
    console.error("[portal-void] failed", error);
    return apiError(error);
  }
}

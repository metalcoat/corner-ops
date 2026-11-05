import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { pinAttemptKeys } from "@/lib/pos-access-guard";
import { PaymentConflictError } from "@/lib/ordering-payments";
import { ItemCancellationError } from "@/lib/ordering-item-cancellations";
import { orderSearchDetail } from "@/lib/ordering-order-search";
import { portalManager, PortalMoneyError, portalQuoteItem, portalRefundAmount, portalRefundItem } from "@/lib/manager-portal-refunds";

export const runtime = "nodejs";

/** Manager portal refunds: an amount off one payment, or one item (quote first, then refund). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const orderId = (await context.params).id;
    const body = await request.json() as Record<string, unknown>;
    const method = body.method === "store_credit" ? "store_credit" : "original";
    const clientMutationId = String(body.clientMutationId || "").slice(0, 120);
    if (body.action === "quote") {
      const actor = await portalManager(null, null);
      return isoJson(await portalQuoteItem({ orderId, itemId: String(body.itemId || ""), quantity: Number(body.quantity), actor }));
    }
    await portalManager(null, null); // signed-in manager first, before anything about the request
    if (!clientMutationId) throw new PortalMoneyError("Missing request ID. Reload and try again.", 400);
    const actor = await portalManager(body.pin, pinAttemptKeys(request.headers));
    const result = body.action === "item"
      ? await portalRefundItem({ orderId, itemId: String(body.itemId || ""), quantity: Number(body.quantity), transactionId: body.transactionId ? String(body.transactionId) : undefined, method, reason: body.reason, clientMutationId: `portal:${clientMutationId}`, actor })
      : await portalRefundAmount({ orderId, transactionId: String(body.transactionId || ""), amountCents: Number(body.amountCents), method, reason: body.reason, clientMutationId: `portal:${clientMutationId}`, actor });
    return isoJson({ result, order: await orderSearchDetail(orderId) }, { status: 201 });
  } catch (error) {
    if (error instanceof PortalMoneyError) return isoJson({ error: error.message }, { status: error.status });
    if (error instanceof PaymentConflictError || error instanceof ItemCancellationError) return isoJson({ error: error.message }, { status: 409 });
    console.error("[portal-refund] failed", error);
    return apiError(error);
  }
}

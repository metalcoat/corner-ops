import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { OrderVoidError, voidSentOrder } from "@/lib/ordering-voids";
import { managerApprovalFromPin } from "@/lib/pos-auth";
import { pinAttemptKeys } from "@/lib/pos-access-guard";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const body = await request.json() as { reason?: unknown; managerPin?: unknown };
    const { id } = await params;
    let approver;
    if (body.managerPin) {
      try { approver = await managerApprovalFromPin(body.managerPin, pinAttemptKeys(request.headers)); }
      catch (error) { return isoJson({ error: error instanceof Error ? error.message : "Manager PIN not accepted." }, { status: 403 }); }
    }
    const result = await voidSentOrder({ orderId: id, business: "Corner Deli", reason: String(body.reason || ""), actor, approver });
    // The void is done; a printer problem must not undo it or read as a failed void.
    try { await dispatchSubmittedOrderPrintJobs(id, "Corner Deli"); } catch (error) { console.error("[order-void] notice print failed", error); }
    return isoJson(result);
  } catch (error) {
    if (error instanceof OrderVoidError) { console.warn("[order-void] rejected", { message: error.message }); return isoJson({ error: error.message }, { status: error.message.includes("authorization") ? 403 : 409 }); }
    console.error("[order-void] failed", error);
    return apiError(error);
  }
}

import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { PaymentConflictError } from "@/lib/ordering-payments";
import { listUnresolvedVoidMoney, resolveVoidMoney } from "@/lib/ordering-void-money";

export const runtime = "nodejs";

/** Voided orders and items still holding the customer's money (refund or store credit by end of day). */
export async function GET() {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return isoJson({ error: "POS authentication required." }, { status: 401 });
    return isoJson({ orders: await listUnresolvedVoidMoney("Corner Deli") });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return isoJson({ error: "POS authentication required." }, { status: 401 });
    const body = (await request.json()) as Record<string, unknown>;
    const orders = await resolveVoidMoney({
      business: "Corner Deli",
      orderId: String(body.orderId || ""),
      transactionId: String(body.transactionId || ""),
      amountCents: Number(body.amountCents),
      method: body.method === "store_credit" ? "store_credit" : "refund",
      reason: String(body.reason || ""),
      clientMutationId: String(body.clientMutationId || ""),
      actor,
    });
    return isoJson({ orders });
  } catch (error) {
    if (error instanceof PaymentConflictError) return isoJson({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}

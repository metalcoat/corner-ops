import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { OrderVoidError, voidSentOrder } from "@/lib/ordering-voids";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const body = await request.json() as { reason?: unknown };
    const { id } = await params;
    return Response.json(await voidSentOrder({ orderId: id, business: "Corner Deli", reason: String(body.reason || ""), actor }));
  } catch (error) {
    if (error instanceof OrderVoidError) { console.warn("[order-void] rejected", { message: error.message }); return Response.json({ error: error.message }, { status: error.message.includes("authorization") ? 403 : 409 }); }
    console.error("[order-void] failed", error);
    return apiError(error);
  }
}

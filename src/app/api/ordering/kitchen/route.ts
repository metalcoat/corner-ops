import { apiError, unauthorized } from "@/lib/http";
import {
  listKitchenOrders,
  OrderConflictError,
  transitionKitchenOrder,
  type KitchenOrderStatus,
} from "@/lib/ordering-order-lifecycle";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

function businessFrom(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function statusFrom(value: unknown): KitchenOrderStatus {
  if (value === "sent_to_kitchen" || value === "in_progress" || value === "ready" || value === "completed" || value === "cancelled") return value;
  throw new Error("Unknown kitchen status.");
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business"));
    if (!await orderingActor(business)) return unauthorized();
    const orders = await listKitchenOrders(business, url.searchParams.get("recent") === "true");
    return Response.json({ business, orders });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const order = await transitionKitchenOrder({
      orderId: String(body.orderId || ""),
      business,
      expectedStatus: statusFrom(body.expectedStatus),
      nextStatus: statusFrom(body.nextStatus),
      actor,
    });
    return Response.json({ order });
  } catch (error) {
    if (error instanceof OrderConflictError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}

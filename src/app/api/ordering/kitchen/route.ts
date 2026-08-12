import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  listKitchenOrders,
  OrderConflictError,
  transitionKitchenOrder,
  type KitchenOrderStatus,
} from "@/lib/ordering-order-lifecycle";
import type { OrderingBusiness } from "@/lib/ordering-core";

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
    const session = await getSession();
    if (!session) return unauthorized();
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business"));
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const orders = await listKitchenOrders(business, url.searchParams.get("recent") === "true");
    return Response.json({ business, orders });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const order = await transitionKitchenOrder({
      orderId: String(body.orderId || ""),
      business,
      expectedStatus: statusFrom(body.expectedStatus),
      nextStatus: statusFrom(body.nextStatus),
      actor: session.email,
    });
    return Response.json({ order });
  } catch (error) {
    if (error instanceof OrderConflictError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}

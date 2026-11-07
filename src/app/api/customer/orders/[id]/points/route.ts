import { isoJson } from "@/lib/timestamp-values";
import { customerSessionHash, readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { getSql } from "@/lib/db";
import { orderPointsRedemptions, pointsStatus, removePointsRedemption, requestPointsRedemption } from "@/lib/ordering-points";

export const runtime = "nodejs";

// Online customers spend points only while signed in, on their own draft order.
async function ownedDraft(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = readCustomerOrderingSession(request);
  if (!session?.customerId || !session.authenticatedAt) throw Object.assign(new Error("Sign in to use your points."), { status: 401 });
  const { id: orderId } = await context.params;
  const [order] = await getSql()`SELECT orders.id FROM ordering_orders orders
    JOIN ordering_customer_web_carts carts ON carts.order_id=orders.id
    WHERE orders.id=${orderId} AND orders.customer_id=${session.customerId}
      AND orders.business='Corner Deli' AND orders.source='web' AND orders.status='draft'
      AND carts.session_hash=${customerSessionHash(session.sessionId)} AND carts.replaced_at IS NULL`;
  if (!order) throw new Error("This checkout is no longer available for points.");
  return { orderId, customerId: session.customerId };
}

async function result(orderId: string, customerId: string) {
  const [order] = await getSql()`SELECT discount_cents,total_cents,amount_due_cents FROM ordering_orders WHERE id=${orderId}`;
  return isoJson({ order, redemptions: await orderPointsRedemptions(orderId), points: await pointsStatus(customerId) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { orderId, customerId } = await ownedDraft(request, context);
    const body = (await request.json()) as { rewardId?: string };
    await requestPointsRedemption({ orderId, rewardId: String(body.rewardId || ""), channel: "web", actor: { id: customerId, name: "Online customer", type: "web" } });
    return result(orderId, customerId);
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Points could not be used." }, { status: (error as { status?: number }).status || 409 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { orderId, customerId } = await ownedDraft(request, context);
    const body = (await request.json()) as { redemptionId?: string };
    await removePointsRedemption(orderId, String(body.redemptionId || ""));
    return result(orderId, customerId);
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Points could not be removed." }, { status: (error as { status?: number }).status || 409 });
  }
}

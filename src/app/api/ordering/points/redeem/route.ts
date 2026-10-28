import { isoJson } from "@/lib/timestamp-values";
import { orderingActor } from "@/lib/ordering-route-auth";
import { getSql } from "@/lib/db";
import { orderPointsRedemptions, removePointsRedemption, requestPointsRedemption } from "@/lib/ordering-points";

// Staff spend a customer's points only after the texted code is verified (enforced in requestPointsRedemption).
async function result(orderId: string) {
  const sql = getSql();
  const [order] = await sql`SELECT total_cents,loyalty_discount_cents FROM ordering_orders WHERE id=${orderId}`;
  const promotions = await sql`SELECT label_snapshot label,discount_cents FROM ordering_order_promotion_applications WHERE order_id=${orderId} ORDER BY application_sequence`;
  const applications = await sql`SELECT label,discount_cents FROM (SELECT label_snapshot label,discount_cents,applied_at,id FROM ordering_order_loyalty_applications WHERE order_id=${orderId} UNION ALL SELECT label_snapshot||' ('||points||' pts)',discount_cents,applied_at,id FROM ordering_order_points_redemptions WHERE order_id=${orderId}) applied ORDER BY applied_at,id`;
  return isoJson({ order, promotions, applications, redemptions: await orderPointsRedemptions(orderId) });
}

export async function POST(request: Request) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return isoJson({ error: "POS authentication required." }, { status: 401 });
    const body = (await request.json()) as Record<string, unknown>, orderId = String(body.orderId || "");
    await requestPointsRedemption({ orderId, rewardId: String(body.rewardId || ""), orderItemId: body.orderItemId ? String(body.orderItemId) : undefined, channel: "pos", actor });
    return result(orderId);
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Points could not be used." }, { status: 409 });
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return isoJson({ error: "POS authentication required." }, { status: 401 });
    const body = (await request.json()) as Record<string, unknown>, orderId = String(body.orderId || "");
    await removePointsRedemption(orderId, String(body.redemptionId || ""));
    return result(orderId);
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Points could not be removed." }, { status: 409 });
  }
}

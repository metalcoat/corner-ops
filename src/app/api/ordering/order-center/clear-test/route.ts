import { apiError } from "@/lib/http";
import { getSql } from "@/lib/db";
import { isAuthorizationResponse, orderingManagerActor } from "@/lib/ordering-route-auth";
import { OrderVoidError, voidSentOrder } from "@/lib/ordering-voids";

export const runtime = "nodejs";

export async function POST() {
  if (process.env.LOCAL_DEVELOPMENT !== "true") {
    return Response.json({ error: "Test-order clearing is disabled in this environment." }, { status: 404 });
  }
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const candidates = await getSql()`
      SELECT id FROM ordering_orders
      WHERE business = 'Corner Deli'
        AND status IN ('draft', 'sent_to_kitchen', 'in_progress', 'ready', 'completed')
        AND payment_status NOT IN ('paid', 'refunded')
      ORDER BY created_at
    `;
    let cleared = 0;
    const skipped: string[] = [];
    for (const candidate of candidates) {
      try {
        await voidSentOrder({ orderId: String(candidate.id), business: "Corner Deli", reason: "Cleared from local test environment", actor });
        await getSql()`UPDATE ordering_payment_station_queue SET status='cancelled',updated_at=NOW() WHERE business='Corner Deli' AND order_id=${candidate.id} AND status='waiting'`;
        cleared += 1;
      } catch (error) {
        if (error instanceof OrderVoidError) skipped.push(String(candidate.id));
        else throw error;
      }
    }
    return Response.json({ cleared, skipped: skipped.length });
  } catch (error) {
    console.error("[clear-test-orders] failed", error);
    return apiError(error);
  }
}

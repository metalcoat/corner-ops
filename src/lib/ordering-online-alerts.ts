import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

/** Sources that should ring the POS when a new order reaches the kitchen. */
export const ONLINE_ALERT_SOURCES = ["web", "online", "customer_web", "kiosk", "ai_phone"];

/**
 * Lightweight, single-query list of online orders waiting in the kitchen for
 * the POS alert poller. The full kitchen list loads every item and modifier
 * and is far too heavy to poll from every device every few seconds.
 */
export async function listWaitingOnlineOrders(business: OrderingBusiness) {
  await ensureOrderingPosSchema();
  return getSql()`
    SELECT id, status, source, created_at, submitted_at
    FROM ordering_orders
    WHERE business = ${business}
      AND status = 'sent_to_kitchen'
      AND source = ANY(${ONLINE_ALERT_SOURCES})
    ORDER BY submitted_at NULLS LAST, created_at
    LIMIT 200
  `;
}

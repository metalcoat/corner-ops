import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

/** Sources that should ring the POS when a new order reaches the kitchen. */
export const ONLINE_ALERT_SOURCES = ["web", "online", "customer_web", "kiosk", "ai_phone"];

/**
 * Lightweight, single-query list of online orders waiting in the kitchen for
 * the POS alert poller. The full kitchen list loads every item and modifier
 * and is far too heavy to poll from every device every few seconds.
 *
 * It also lists online orders that were paid but are still drafts (a send rule
 * failed after the card was charged), so staff hear about them and send them
 * from the Order Center instead of the customer waiting on food nobody saw.
 */
export async function listWaitingOnlineOrders(business: OrderingBusiness) {
  await ensureOrderingPosSchema();
  return getSql()`
    SELECT id, status, source, created_at, COALESCE(kitchen_release_at, submitted_at) AS submitted_at,
           (status = 'draft') AS paid_not_sent
    FROM ordering_orders
    WHERE business = ${business}
      AND source = ANY(${ONLINE_ALERT_SOURCES})
      AND (
        (status = 'sent_to_kitchen' AND (kitchen_release_at IS NULL OR kitchen_release_at <= NOW()))
        OR (status = 'draft' AND paid_cents > 0 AND created_at > NOW() - INTERVAL '1 day')
      )
    ORDER BY submitted_at NULLS LAST, created_at
    LIMIT 200
  `;
}

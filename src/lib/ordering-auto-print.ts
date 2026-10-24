import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { randomUUID } from "node:crypto";
import { notifyPosStationsOfOnlineOrder } from "@/lib/push-notifications";

let schemaPromise: Promise<void> | null = null;
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await getSql()`INSERT INTO ordering_external_print_settings (business) VALUES ('Corner Deli'), ('Tiki') ON CONFLICT DO NOTHING`;
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

export async function externalPrintSettings(business: OrderingBusiness) {
  await ensureSchema();
  const row = (await getSql()`SELECT auto_print_enabled,updated_at FROM ordering_external_print_settings WHERE business=${business}`)[0];
  return { externalKitchenAutoPrint: Boolean(row?.auto_print_enabled), updatedAt: row?.updated_at || null };
}

export async function saveExternalPrintSettings(business: OrderingBusiness, enabled: boolean, actor: OrderingActor) {
  if (!canManagePos(actor)) throw new Error("Manager or owner authorization is required.");
  await ensureSchema();
  await getSql()`UPDATE ordering_external_print_settings SET auto_print_enabled=${enabled},updated_by=${actor.id},updated_at=NOW() WHERE business=${business}`;
  return externalPrintSettings(business);
}

export async function dispatchSubmittedOrderPrintJobs(orderId: string, business: OrderingBusiness) {
  await ensureSchema();
  const order = (await getSql()`SELECT id FROM ordering_orders WHERE id=${orderId} AND business=${business}`)[0];
  if (!order) return { dispatched: false, reason: "order_not_found" };
  const settings = await externalPrintSettings(business);
  if (!settings.externalKitchenAutoPrint) {
    await getSql()`UPDATE ordering_print_jobs SET status='not_configured',error_message='Automatic kitchen printing is paused in POS hardware settings.' WHERE order_id=${orderId} AND business=${business} AND purpose='kitchen_production' AND status IN ('not_configured','queued')`;
    return { dispatched: false, paused: true };
  }
  await dispatchOrderPrintJobs(orderId, business);
  return { dispatched: true, paused: false };
}

const ONLINE_SOURCES = ["web", "online", "customer_web", "kiosk", "ai_phone"];

/**
 * Releases scheduled orders whose prep time has come (ordering-kitchen-release.ts):
 * prints the kitchen ticket (auto-print settings apply) and notifies the POS for
 * online orders, once per order. Runs from ordering maintenance every minute.
 */
export async function releaseHeldKitchenOrders(business: OrderingBusiness) {
  const sql = getSql();
  const due = await sql`
    SELECT id, source, display_number, service_type, first_name_snapshot, last_name_snapshot FROM ordering_orders
    WHERE business=${business} AND status='sent_to_kitchen'
      -- No short cutoff: an order released while maintenance was down still goes out when it's back.
      AND kitchen_release_at<=NOW() AND kitchen_release_at>NOW()-INTERVAL '7 days'
      AND NOT EXISTS(SELECT 1 FROM ordering_order_events ev WHERE ev.order_id=ordering_orders.id AND ev.event_type='kitchen_released')
    ORDER BY kitchen_release_at LIMIT 25`;
  let released = 0;
  for (const order of due) {
    const claimed = await sql`
      INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)
      SELECT ${randomUUID()},id,version,'kitchen_released','system','kitchen-release','{}'::jsonb FROM ordering_orders
      WHERE id=${order.id} AND status='sent_to_kitchen'
        AND NOT EXISTS(SELECT 1 FROM ordering_order_events ev WHERE ev.order_id=${order.id} AND ev.event_type='kitchen_released')
      RETURNING id`;
    if (!claimed.length) continue;
    released += 1;
    await dispatchSubmittedOrderPrintJobs(String(order.id), business).catch((error) => console.error(`Kitchen release print failed for ${order.id}`, error));
    const source = String(order.source || "").toLowerCase();
    if (ONLINE_SOURCES.includes(source))
      await notifyPosStationsOfOnlineOrder({
        business, orderId: String(order.id), displayNumber: String(order.display_number), source,
        serviceType: String(order.service_type || "online"),
        customerName: `${String(order.first_name_snapshot || "")} ${String(order.last_name_snapshot || "")}`.trim(),
      }).catch(() => undefined);
  }
  return { released };
}

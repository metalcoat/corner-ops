import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";

let schemaPromise: Promise<void> | null = null;
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await getSql()`CREATE TABLE IF NOT EXISTS ordering_external_print_settings (business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli','Tiki')), auto_print_enabled BOOLEAN NOT NULL DEFAULT FALSE, updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
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

import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingHardwareSchema } from "@/lib/ordering-hardware-schema";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import type { OrderingBusiness } from "@/lib/ordering-core";

export class PaymentStationError extends Error {}

export async function paymentStationProfile(business: OrderingBusiness, stationKey: string) {
  await ensureOrderingHardwareSchema();
  const key = stationKey.trim().toLowerCase();
  if (!key) return null;
  return (await getSql()`SELECT station.*,receipt.adapter_config receipt_printer_config,terminal.reported_status terminal_status,terminal.last_seen_at terminal_last_seen_at FROM ordering_payment_stations station LEFT JOIN ordering_hardware_devices receipt ON receipt.id=station.receipt_printer_id LEFT JOIN ordering_hardware_devices terminal ON terminal.id=station.payment_terminal_id WHERE station.business=${business} AND station.station_key=${key} AND station.active=TRUE LIMIT 1`)[0] || null;
}

export async function listPaymentQueue(business: OrderingBusiness) {
  await ensureOrderingHardwareSchema();
  return getSql()`SELECT queue.*,orders.display_number,orders.first_name_snapshot,orders.last_name_snapshot,orders.service_type,orders.total_cents,orders.paid_cents,orders.amount_due_cents,orders.payment_status FROM ordering_payment_station_queue queue JOIN ordering_orders orders ON orders.id=queue.order_id WHERE queue.business=${business} AND queue.status IN ('queued','claimed') ORDER BY CASE queue.status WHEN 'claimed' THEN 0 ELSE 1 END,queue.queued_at`;
}

export async function queueForPayment(input:{business:OrderingBusiness;orderId:string;checkId?:string|null;sourceStationKey?:string;note?:string;actor:OrderingActor}) {
  await ensureOrderingHardwareSchema();
  const sql=getSql(),order=(await sql`SELECT id,amount_due_cents FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business}`)[0];
  if(!order)throw new PaymentStationError("Order was not found.");
  if(Number(order.amount_due_cents)<=0)throw new PaymentStationError("This order is already paid.");
  if(input.checkId&&!((await sql`SELECT id FROM ordering_checks WHERE id=${input.checkId} AND order_id=${input.orderId}`)[0]))throw new PaymentStationError("Check was not found.");
  const existing=(await sql`SELECT * FROM ordering_payment_station_queue WHERE business=${input.business} AND order_id=${input.orderId} AND COALESCE(check_id,'00000000-0000-0000-0000-000000000000'::uuid)=COALESCE(${input.checkId||null}::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND status IN ('queued','claimed')`)[0];
  if(existing)return {...existing,duplicate:true};
  const id=randomUUID();
  return {...(await sql`INSERT INTO ordering_payment_station_queue(id,business,order_id,check_id,source_station_key,requested_by,request_note) VALUES(${id},${input.business},${input.orderId},${input.checkId||null},${String(input.sourceStationKey||'').trim().toLowerCase()},${input.actor.id},${String(input.note||'').trim().slice(0,300)}) RETURNING *`)[0],duplicate:false};
}

export async function updatePaymentQueue(input:{business:OrderingBusiness;id:string;action:'claim'|'cancel'|'complete';actor:OrderingActor}) {
  await ensureOrderingHardwareSchema();
  const sql=getSql();
  if(input.action==='claim')return (await sql`UPDATE ordering_payment_station_queue SET status='claimed',claimed_by=${input.actor.id},claimed_at=NOW() WHERE id=${input.id} AND business=${input.business} AND status IN ('queued','claimed') RETURNING *`)[0]||null;
  if(input.action==='cancel')return (await sql`UPDATE ordering_payment_station_queue SET status='cancelled',cancelled_at=NOW() WHERE id=${input.id} AND business=${input.business} AND status IN ('queued','claimed') RETURNING *`)[0]||null;
  return (await sql`UPDATE ordering_payment_station_queue SET status='completed',completed_at=NOW() WHERE id=${input.id} AND business=${input.business} AND status IN ('queued','claimed') RETURNING *`)[0]||null;
}

export async function completePaidPaymentQueue(business:OrderingBusiness,orderId:string,checkId?:string|null){
  await ensureOrderingHardwareSchema();
  await getSql()`UPDATE ordering_payment_station_queue SET status='completed',completed_at=NOW() WHERE business=${business} AND order_id=${orderId} AND (${checkId||null}::uuid IS NULL OR check_id=${checkId||null}::uuid) AND status IN ('queued','claimed')`;
}

export async function cancelPaymentQueueEntries(business: OrderingBusiness, orderId: string) {
  await ensureOrderingHardwareSchema();
  return getSql()`UPDATE ordering_payment_station_queue SET status='cancelled',cancelled_at=NOW() WHERE business=${business} AND order_id=${orderId} AND status IN ('queued','claimed') RETURNING id`;
}

import { getSql } from "@/lib/db";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { BUSINESS_TIMEZONE, getPosSettings } from "@/lib/ordering-pos-settings";

export function businessDate(value = new Date(), timezone = BUSINESS_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export async function listOrders(input: { business: OrderingBusiness; date?: string; allOpen?: boolean; query?: string }) {
  await ensureOrderingCustomerSchema();
  await ensureOrderingAccountSchema();
  const q = String(input.query || "").trim();
  const digits = q.replace(/\D/g, "");
  const like = `%${q}%`;
  const digitLike = `%${digits}%`;
  const timezone = (await getPosSettings(input.business)).businessTimezone;
  const date = input.date || businessDate(new Date(), timezone);
  const openOnly = Boolean(input.allOpen);
  const includeOverdue = !openOnly && date === businessDate(new Date(), timezone);
  return getSql()`
    SELECT o.id,o.display_number,o.status,o.payment_status,o.service_type,o.source,o.order_origin,
      o.total_cents,o.paid_cents,o.amount_due_cents,o.created_at,o.updated_at,o.scheduled_for,o.voided_at,o.void_reason,
      o.first_name_snapshot,o.last_name_snapshot,o.phone_snapshot,
      COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),NULLIF(c.display_name,''),'Guest') customer_name,
      COALESCE(NULLIF(o.phone_snapshot,''),p.display_phone,o.caller_phone) customer_phone,
      a.formatted_address delivery_address,a.line2 delivery_unit,
      ((o.created_at AT TIME ZONE ${timezone})::date < ${date}::date AND o.payment_status NOT IN ('paid','refunded') AND o.status <> 'cancelled') overdue_unpaid
    FROM ordering_orders o
    LEFT JOIN ordering_customers c ON c.id=o.customer_id
    LEFT JOIN LATERAL (SELECT display_phone FROM ordering_customer_phones WHERE customer_id=c.id ORDER BY is_primary DESC,created_at LIMIT 1) p ON TRUE
    LEFT JOIN ordering_order_delivery_addresses a ON a.order_id=o.id
    WHERE o.business=${input.business}
      AND (CASE WHEN ${openOnly} THEN o.payment_status NOT IN ('paid','refunded') AND o.status <> 'cancelled' ELSE ((o.created_at AT TIME ZONE ${timezone})::date=${date}::date OR (${includeOverdue} AND (o.created_at AT TIME ZONE ${timezone})::date < ${date}::date AND o.payment_status NOT IN ('paid','refunded') AND o.status <> 'cancelled')) END)
      AND (${q}='' OR o.display_number ILIKE ${like} OR o.first_name_snapshot ILIKE ${like} OR o.last_name_snapshot ILIKE ${like}
        OR trim(o.first_name_snapshot||' '||o.last_name_snapshot) ILIKE ${like} OR c.display_name ILIKE ${like}
        OR regexp_replace(COALESCE(NULLIF(o.phone_snapshot,''),p.display_phone,o.caller_phone),'[^0-9]','','g') LIKE ${digitLike}
        OR a.formatted_address ILIKE ${like} OR a.line1 ILIKE ${like})
    ORDER BY CASE WHEN ${includeOverdue} AND (o.created_at AT TIME ZONE ${timezone})::date < ${date}::date AND o.payment_status NOT IN ('paid','refunded') AND o.status <> 'cancelled' THEN 0 WHEN o.payment_status IN ('paid','refunded') THEN 2 ELSE 1 END,
      CASE WHEN ${openOnly} THEN o.created_at END ASC, o.created_at DESC
  `;
}

export async function getOrderDetail(business: OrderingBusiness, id: string) {
  await ensureOrderingAccountSchema();
  await ensureOrderingCustomerSchema();
  const sql = getSql();
  const rows = await sql`SELECT o.*,COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer_name,COALESCE(NULLIF(o.phone_snapshot,''),o.caller_phone) customer_phone,a.formatted_address delivery_address,a.line2 delivery_unit FROM ordering_orders o LEFT JOIN ordering_order_delivery_addresses a ON a.order_id=o.id WHERE o.business=${business} AND o.id=${id} LIMIT 1`;
  if (!rows[0]) return null;
  const order = rows[0];
  order.items = await sql`SELECT * FROM ordering_order_items WHERE order_id=${id} ORDER BY sort_order,created_at`;
  for (const item of order.items) {
    item.modifiers = await sql`SELECT * FROM ordering_order_item_modifiers WHERE order_item_id=${item.id} ORDER BY created_at`;
  }
  order.events = await sql`SELECT event_type,actor_type,actor_id,details,created_at FROM ordering_order_events WHERE order_id=${id} ORDER BY created_at`;
  return order;
}

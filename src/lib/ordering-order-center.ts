import { getSql } from "@/lib/db";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { BUSINESS_TIMEZONE, getPosSettings } from "@/lib/ordering-pos-settings";

export function businessDate(value = new Date(), timezone = BUSINESS_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export async function listOrders(input: { business: OrderingBusiness; date?: string; allOpen?: boolean; futureOnly?: boolean; query?: string; searchDays?: number }) {
  await ensureOrderingCustomerSchema();
  await ensureOrderingAccountSchema();
  const q = String(input.query || "").trim();
  const digits = q.replace(/\D/g, "");
  const like = `%${q}%`;
  const digitLike = `%${digits}%`;
  const timezone = (await getPosSettings(input.business)).businessTimezone;
  const date = input.date || businessDate(new Date(), timezone);
  const openOnly = Boolean(input.allOpen);
  const futureOnly = Boolean(input.futureOnly);
  const includeOverdue = !openOnly && date === businessDate(new Date(), timezone);
  const searchDays = Math.max(1, Math.min(365, Number(input.searchDays || 60)));
  const searchingHistory = q.length > 0;
  return getSql()`
    SELECT o.id,o.display_number,o.status,o.payment_status,o.service_type,o.source,o.order_origin,
      o.total_cents,o.paid_cents,o.amount_due_cents,o.created_at,o.updated_at,o.scheduled_for,o.voided_at,o.void_reason,
      o.first_name_snapshot,o.last_name_snapshot,o.phone_snapshot,
      COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),NULLIF(c.display_name,''),'Guest') customer_name,
      COALESCE(NULLIF(o.phone_snapshot,''),p.display_phone,o.caller_phone) customer_phone,
      a.formatted_address delivery_address,a.line2 delivery_unit,
      ((o.created_at AT TIME ZONE ${timezone})::date < ${date}::date AND o.amount_due_cents > 0 AND o.status <> 'cancelled') overdue_unpaid,
      (o.service_type='pickup' AND o.amount_due_cents > 0 AND o.status<>'cancelled' AND o.created_at<=NOW()-INTERVAL '40 minutes') pickup_attention,
      -- Who took it: the POS employee who rang it (created_by is their id), else where it came from.
      CASE o.source WHEN 'web' THEN 'Online' WHEN 'ai_phone' THEN 'AI phone' WHEN 'kiosk' THEN 'Kiosk'
        ELSE COALESCE(taker.name,NULLIF(o.created_by,'')) END taken_by,
      sender.name sent_by,payer.name paid_by,
      driver.name driver_name,
      COALESCE(o.scheduled_for,o.promised_at,o.created_at) due_at,
      on_clock.names drivers_on_clock
    FROM ordering_orders o
    LEFT JOIN employees taker ON taker.id::text=o.created_by
    LEFT JOIN employees sender ON sender.id::text=o.submitted_by
    LEFT JOIN LATERAL (SELECT e.name FROM ordering_payment_transactions t JOIN employees e ON e.id::text=t.created_by WHERE t.order_id=o.id ORDER BY t.created_at DESC LIMIT 1) payer ON TRUE
    LEFT JOIN LATERAL (SELECT e.name FROM ordering_delivery_assignments d JOIN employees e ON e.id=d.driver_employee_id WHERE d.order_id=o.id AND d.cancelled_at IS NULL ORDER BY d.assigned_at DESC NULLS LAST LIMIT 1) driver ON TRUE
    -- No driver assigned: whoever was on the clock as a driver when the order was due.
    LEFT JOIN LATERAL (SELECT string_agg(DISTINCT e.name,', ') names FROM time_entries t JOIN employees e ON e.id=t.employee_id
      WHERE o.service_type='delivery' AND t.business=o.business AND (t.role_group='Driver' OR e.role_group='Driver')
        AND t.clock_in<=COALESCE(o.scheduled_for,o.promised_at,o.created_at)
        AND (t.clock_out IS NULL OR t.clock_out>=COALESCE(o.scheduled_for,o.promised_at,o.created_at))) on_clock ON TRUE
    LEFT JOIN ordering_customers c ON c.id=o.customer_id
    LEFT JOIN LATERAL (SELECT display_phone FROM ordering_customer_phones WHERE customer_id=c.id ORDER BY is_primary DESC,created_at LIMIT 1) p ON TRUE
    LEFT JOIN ordering_order_delivery_addresses a ON a.order_id=o.id
    WHERE o.business=${input.business}
      AND (CASE WHEN ${searchingHistory} THEN o.created_at >= NOW()-(${searchDays}::text||' days')::interval WHEN ${futureOnly} THEN o.scheduled_for > NOW() AND o.status <> 'cancelled' WHEN ${openOnly} THEN o.amount_due_cents > 0 AND o.status <> 'cancelled' ELSE ((o.created_at AT TIME ZONE ${timezone})::date=${date}::date OR (${includeOverdue} AND (o.created_at AT TIME ZONE ${timezone})::date < ${date}::date AND o.amount_due_cents > 0 AND o.status <> 'cancelled')) END)
      AND (${q}='' OR o.display_number ILIKE ${like} OR o.first_name_snapshot ILIKE ${like} OR o.last_name_snapshot ILIKE ${like}
        OR trim(o.first_name_snapshot||' '||o.last_name_snapshot) ILIKE ${like} OR c.display_name ILIKE ${like}
        OR regexp_replace(COALESCE(NULLIF(o.phone_snapshot,''),p.display_phone,o.caller_phone),'[^0-9]','','g') LIKE ${digitLike}
        OR a.formatted_address ILIKE ${like} OR a.line1 ILIKE ${like})
    ORDER BY CASE WHEN ${includeOverdue} AND (o.created_at AT TIME ZONE ${timezone})::date < ${date}::date AND o.amount_due_cents > 0 AND o.status <> 'cancelled' THEN 0 WHEN o.amount_due_cents <= 0 THEN 2 ELSE 1 END,
      CASE WHEN ${futureOnly} THEN o.scheduled_for END ASC, CASE WHEN ${openOnly} THEN o.created_at END ASC, o.created_at DESC
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
  order.events = await sql`SELECT event.event_type,event.actor_type,event.actor_id,event.details,event.created_at,COALESCE(NULLIF(event.details->>'actorName',''),employee.name,event.actor_id) actor_name FROM ordering_order_events event LEFT JOIN employees employee ON employee.id::text=event.actor_id WHERE event.order_id=${id} ORDER BY event.created_at`;
  return order;
}

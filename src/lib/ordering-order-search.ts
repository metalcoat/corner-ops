import { getSql } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import { getOrderDetail } from "@/lib/ordering-order-center";
import { BUSINESS_TIMEZONE } from "@/lib/ordering-pos-settings";
import { toIsoTimestamp } from "@/lib/timestamp-values";
import type { OrderSearchFilters } from "@/lib/order-search-filters";

/** Manager order search: past orders by date and who/where/how, each one opening its full accountability trail. */
const BUSINESS = "Corner Deli";
export const ORDER_SEARCH_LIMIT = 300;
export { OrderSearchInputError, parseOrderSearch, type OrderSearchFilters } from "@/lib/order-search-filters";

export async function searchOrders(filters: OrderSearchFilters) {
  await ensureOrderingCustomerSchema();
  await ensureOrderingAccountSchema();
  const f = filters, tz = BUSINESS_TIMEZONE;
  const like = (value: string) => `%${value}%`;
  const rows = await getSql()`
    SELECT o.id,o.display_number,o.status,o.payment_status,o.service_type,o.source,o.created_at,o.submitted_at,o.paid_at,o.voided_at,o.void_reason,
      o.total_cents,o.paid_cents,o.amount_due_cents,
      COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),NULLIF(c.display_name,''),'Guest') customer_name,
      COALESCE(NULLIF(o.phone_snapshot,''),p.display_phone,NULLIF(o.caller_phone,'')) customer_phone,
      CASE WHEN o.service_type IN ('delivery','no_contact_delivery') THEN a.formatted_address END delivery_address,
      CASE o.source WHEN 'web' THEN 'Online' WHEN 'ai_phone' THEN 'AI phone' WHEN 'kiosk' THEN 'Kiosk' ELSE COALESCE(taker.name,NULLIF(o.created_by,'')) END taken_by,
      sender.name sent_by, COALESCE(payer.name,tenders.last_by) paid_by, tenders.summary tenders
    FROM ordering_orders o
    LEFT JOIN employees taker ON taker.id::text=o.created_by
    LEFT JOIN employees sender ON sender.id::text=o.submitted_by
    LEFT JOIN employees payer ON payer.id::text=o.paid_by
    LEFT JOIN ordering_customers c ON c.id=o.customer_id
    LEFT JOIN LATERAL (SELECT display_phone FROM ordering_customer_phones WHERE customer_id=c.id ORDER BY is_primary DESC,created_at LIMIT 1) p ON TRUE
    LEFT JOIN ordering_order_delivery_addresses a ON a.order_id=o.id
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT CASE WHEN t.last4<>'' THEN COALESCE(NULLIF(t.brand,''),'Card')||' ····'||t.last4 ELSE replace(t.tender_type,'_',' ') END, ', ') summary,
        (array_agg(COALESCE(NULLIF(t.details->>'actorName',''),e.name) ORDER BY t.created_at DESC))[1] last_by
      FROM ordering_payment_transactions t LEFT JOIN employees e ON e.id::text=t.created_by
      WHERE t.order_id=o.id AND t.transaction_type='payment' AND t.status='approved'
    ) tenders ON TRUE
    WHERE o.business=${BUSINESS}
      AND (o.created_at AT TIME ZONE ${tz})::date BETWEEN ${f.from}::date AND ${f.to}::date
      AND (${f.number}='' OR o.display_number ILIKE ${like(f.number)})
      AND (${f.name}='' OR trim(o.first_name_snapshot||' '||o.last_name_snapshot) ILIKE ${like(f.name)} OR c.display_name ILIKE ${like(f.name)})
      AND (${f.phone}='' OR regexp_replace(COALESCE(o.phone_snapshot,'')||'|'||COALESCE(o.caller_phone,'')||'|'||COALESCE(p.display_phone,''),'[^0-9|]','','g') LIKE ${like(f.phone)})
      AND (${f.address}='' OR a.formatted_address ILIKE ${like(f.address)} OR a.line1 ILIKE ${like(f.address)} OR a.line2 ILIKE ${like(f.address)})
      AND (${f.last4}='' OR EXISTS(SELECT 1 FROM ordering_payment_transactions t WHERE t.order_id=o.id AND t.last4=${f.last4}))
      AND (${f.serviceType}='' OR (${f.serviceType}='pickup' AND o.service_type IN ('pickup','curbside')) OR (${f.serviceType}='delivery' AND o.service_type IN ('delivery','no_contact_delivery')) OR (${f.serviceType}='dine_in' AND o.service_type IN ('dine_in','bar')))
      AND (${f.channel}='' OR o.source=${f.channel})
      AND (${f.payment}=''
        OR (${f.payment}='paid' AND o.voided_at IS NULL AND o.payment_status='paid')
        OR (${f.payment}='owes' AND o.voided_at IS NULL AND o.status<>'cancelled' AND o.amount_due_cents>0)
        OR (${f.payment}='refunded' AND o.payment_status IN ('refunded','partially_refunded'))
        OR (${f.payment}='voided' AND o.voided_at IS NOT NULL))
      AND (${f.tender}='' OR EXISTS(SELECT 1 FROM ordering_payment_transactions t WHERE t.order_id=o.id AND t.transaction_type='payment' AND t.status='approved'
        AND CASE ${f.tender} WHEN 'cash' THEN t.tender_type='cash' WHEN 'card' THEN t.tender_type='card' ELSE t.tender_type NOT IN ('cash','card') END))
    ORDER BY o.created_at DESC
    LIMIT ${ORDER_SEARCH_LIMIT + 1}
  `;
  const orders = rows.slice(0, ORDER_SEARCH_LIMIT).map((row) => ({
    id: String(row.id), number: String(row.display_number), status: String(row.status), paymentStatus: String(row.payment_status),
    serviceType: String(row.service_type), channel: String(row.source),
    createdAt: toIsoTimestamp(row.created_at), sentAt: toIsoTimestamp(row.submitted_at), paidAt: toIsoTimestamp(row.paid_at), voidedAt: toIsoTimestamp(row.voided_at), voidReason: String(row.void_reason || ""),
    totalCents: Number(row.total_cents), paidCents: Number(row.paid_cents), dueCents: Number(row.amount_due_cents),
    customerName: String(row.customer_name), customerPhone: String(row.customer_phone || ""), deliveryAddress: String(row.delivery_address || ""),
    takenBy: String(row.taken_by || ""), sentBy: String(row.sent_by || ""), paidBy: String(row.paid_by || ""), tenders: String(row.tenders || ""),
  }));
  return { filters: f, orders, truncated: rows.length > ORDER_SEARCH_LIMIT };
}

/** One order with its line items, tenders and the full who-did-what trail. */
export async function orderSearchDetail(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const order = await getOrderDetail(BUSINESS, id);
  if (!order) return null;
  const payments = await getSql()`SELECT t.created_at,t.transaction_type,t.tender_type,t.amount_cents,t.brand,t.last4,t.reason,t.status,
      COALESCE(NULLIF(t.details->>'actorName',''),e.name,NULLIF(t.created_by,''),'Unknown') taken_by
    FROM ordering_payment_transactions t LEFT JOIN employees e ON e.id::text=t.created_by WHERE t.order_id=${id} ORDER BY t.created_at`;
  return {
    id, number: String(order.display_number), status: String(order.status), paymentStatus: String(order.payment_status),
    serviceType: String(order.service_type), channel: String(order.source),
    customerName: String(order.customer_name || ""), customerPhone: String(order.customer_phone || ""),
    deliveryAddress: [order.delivery_address, order.delivery_unit].filter(Boolean).join(", "),
    takenBy: String(order.taken_by || ""), voidReason: String(order.void_reason || ""),
    totalCents: Number(order.total_cents), paidCents: Number(order.paid_cents), dueCents: Number(order.amount_due_cents),
    tipCents: Number(order.tip_cents || 0), deliveryFeeCents: Number(order.delivery_fee_cents || 0),
    items: (order.items as Record<string, unknown>[]).map((item) => ({
      name: [item.item_name_snapshot, item.variant_name_snapshot].filter(Boolean).join(" · "),
      quantity: Number(item.quantity), cancelled: Number(item.cancelled_quantity || 0), totalCents: Number(item.line_total_cents || 0),
      addedBy: String(item.added_by_name || ""),
      modifiers: ((item.modifiers as Record<string, unknown>[]) || []).map((modifier) => String(modifier.option_name_snapshot || "")).filter(Boolean),
    })),
    payments: payments.map((row) => ({ at: toIsoTimestamp(row.created_at), kind: String(row.transaction_type), tender: String(row.tender_type), status: String(row.status), amountCents: Number(row.amount_cents), card: row.last4 ? `${row.brand || "Card"} ····${row.last4}` : "", by: String(row.taken_by), reason: String(row.reason || "") })),
    trail: order.trail as { at: string; label: string; who: string; detail?: string }[],
  };
}

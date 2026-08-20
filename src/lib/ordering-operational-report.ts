import { getSql } from "@/lib/db";
import { ensureOrderingDeliverySchema } from "@/lib/ordering-delivery-schema";
import { ensureOrderingGiftCardSchema } from "@/lib/ordering-gift-card-schema";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";

const MAX_RANGE_DAYS = 366;
const OVERDUE_MINUTES = 30;
const integer = (value: unknown) => Number(value || 0);

function dateBoundary(value: string, end = false): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Report dates must use YYYY-MM-DD.");
  const target = new Date(`${value}T12:00:00Z`); if (end) target.setUTCDate(target.getUTCDate()+1);
  const key = target.toISOString().slice(0,10);
  const approximate = new Date(`${key}T04:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(approximate);
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const representedHour=Number(values.hour); const representedMinute=Number(values.minute);
  return new Date(approximate.getTime()+(4-representedHour)*3_600_000-representedMinute*60_000);
}

export async function orderingOperationalReport(input: { business: OrderingBusiness; start: string; end: string }) {
  await Promise.all([ensureOrderingPromotionSchema(), ensureOrderingDeliverySchema(), ensureOrderingGiftCardSchema()]);
  const start = dateBoundary(input.start);
  const end = dateBoundary(input.end, true);
  if (end <= start || end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new Error("Report range must be between one and 366 days.");
  const sql = getSql();
  const [summary, tenders, giftCards, services, channels, items, categories, voids, openOrders, actions] = await Promise.all([
    sql`SELECT COUNT(*)::int orders,
      COALESCE(SUM(gross_base_merchandise_cents),0)::bigint gross_merchandise_cents,
      COALESCE(SUM(modifier_revenue_cents),0)::bigint modifier_revenue_cents,
      COALESCE(SUM(promotion_discount_cents),0)::bigint promotion_discount_cents,
      COALESCE(SUM(loyalty_discount_cents),0)::bigint loyalty_discount_cents,
      COALESCE(SUM(delivery_fee_cents),0)::bigint delivery_fees_cents,
      COALESCE(SUM(net_merchandise_cents),0)::bigint net_merchandise_cents,
      COALESCE(SUM(tax_cents),0)::bigint tax_cents,
      COALESCE(SUM(tip_cents),0)::bigint tip_cents,
      COALESCE(SUM(total_cents),0)::bigint order_total_cents
      FROM ordering_orders WHERE business=${input.business} AND created_at>=${start.toISOString()} AND created_at<${end.toISOString()}
      AND status NOT IN ('draft','cancelled')`,
    sql`SELECT tender_type,
      COALESCE(SUM(CASE WHEN transaction_type='payment' THEN amount_cents ELSE 0 END),0)::bigint payments_cents,
      COALESCE(SUM(CASE WHEN transaction_type IN ('refund','void') THEN amount_cents ELSE 0 END),0)::bigint reversals_cents,
      COUNT(*) FILTER (WHERE transaction_type='payment')::int payment_count,
      COUNT(*) FILTER (WHERE transaction_type IN ('refund','void'))::int reversal_count
      FROM ordering_payment_transactions WHERE business=${input.business} AND status='approved' AND created_at>=${start.toISOString()} AND created_at<${end.toISOString()}
      GROUP BY tender_type ORDER BY tender_type`,
    sql`SELECT entry_type, COALESCE(SUM(ABS(delta_balance_cents)),0)::bigint amount_cents, COUNT(*)::int count
      FROM ordering_gift_card_ledger WHERE business=${input.business} AND created_at>=${start.toISOString()} AND created_at<${end.toISOString()}
      GROUP BY entry_type ORDER BY entry_type`,
    sql`SELECT service_type label, COUNT(*)::int orders, COALESCE(SUM(total_cents),0)::bigint sales_cents
      FROM ordering_orders WHERE business=${input.business} AND created_at>=${start.toISOString()} AND created_at<${end.toISOString()} AND status NOT IN ('draft','cancelled') GROUP BY service_type ORDER BY sales_cents DESC`,
    sql`SELECT source label, COUNT(*)::int orders, COALESCE(SUM(total_cents),0)::bigint sales_cents
      FROM ordering_orders WHERE business=${input.business} AND created_at>=${start.toISOString()} AND created_at<${end.toISOString()} AND status NOT IN ('draft','cancelled') GROUP BY source ORDER BY sales_cents DESC`,
    sql`SELECT item_name_snapshot label, SUM(quantity-cancelled_quantity)::int quantity, COALESCE(SUM(line_total_cents*(quantity-cancelled_quantity)/quantity),0)::bigint sales_cents
      FROM ordering_order_items item JOIN ordering_orders orders ON orders.id=item.order_id
      WHERE orders.business=${input.business} AND orders.created_at>=${start.toISOString()} AND orders.created_at<${end.toISOString()} AND orders.status NOT IN ('draft','cancelled')
      GROUP BY item_name_snapshot ORDER BY sales_cents DESC, label LIMIT 50`,
    sql`SELECT COALESCE(NULLIF(category_name_snapshot,''),'Uncategorized (legacy)') label, SUM(quantity-cancelled_quantity)::int quantity, COALESCE(SUM(line_total_cents*(quantity-cancelled_quantity)/quantity),0)::bigint sales_cents
      FROM ordering_order_items item JOIN ordering_orders orders ON orders.id=item.order_id
      WHERE orders.business=${input.business} AND orders.created_at>=${start.toISOString()} AND orders.created_at<${end.toISOString()} AND orders.status NOT IN ('draft','cancelled')
      GROUP BY COALESCE(NULLIF(category_name_snapshot,''),'Uncategorized (legacy)') ORDER BY sales_cents DESC, label`,
    sql`SELECT COUNT(*)::int order_voids, COALESCE(SUM(total_cents),0)::bigint voided_order_cents
      FROM ordering_orders WHERE business=${input.business} AND voided_at>=${start.toISOString()} AND voided_at<${end.toISOString()}`,
    sql`SELECT id,display_number,status,payment_status,service_type,amount_due_cents,created_at,
      (created_at < NOW()-${`${OVERDUE_MINUTES} minutes`}::interval) overdue
      FROM ordering_orders WHERE business=${input.business} AND status NOT IN ('completed','cancelled') AND amount_due_cents>0
      ORDER BY overdue DESC,created_at ASC LIMIT 100`,
    sql`SELECT event_type,actor_id,actor_type,COUNT(*)::int count,MAX(event.created_at) latest_at
      FROM ordering_order_events event JOIN ordering_orders orders ON orders.id=event.order_id
      WHERE orders.business=${input.business} AND event.created_at>=${start.toISOString()} AND event.created_at<${end.toISOString()} AND event.actor_type IN ('employee','web')
      GROUP BY event_type,actor_id,actor_type ORDER BY count DESC,event_type LIMIT 100`,
  ]);
  const mapMoney = (rows: Record<string, unknown>[]) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([key,value]) => key.endsWith("_cents") || key === "count" || key === "orders" || key === "quantity" ? [key,integer(value)] : [key,value])));
  return {
    business: input.business, range: { start: input.start, end: input.end, businessDayStartsAt: "04:00 America/New_York" }, generatedAt: new Date().toISOString(),
    summary: mapMoney(summary)[0], tenders: mapMoney(tenders), giftCards: mapMoney(giftCards), salesByServiceType: mapMoney(services), salesByChannel: mapMoney(channels),
    salesByItem: mapMoney(items), salesByCategory: mapMoney(categories), voids: mapMoney(voids)[0],
    openOrders: mapMoney(openOrders), openOrderSummary: { count: openOrders.length, overdueCount: openOrders.filter((row) => row.overdue).length, amountDueCents: openOrders.reduce((sum,row) => sum+integer(row.amount_due_cents),0), overdueAfterMinutes: OVERDUE_MINUTES },
    employeeActions: mapMoney(actions), notes: ["Sales exclude draft and cancelled orders.", "Tender and gift-card figures come from immutable ledgers by entry timestamp.", "Legacy lines without a category snapshot are not reclassified from mutable menu data."],
  };
}

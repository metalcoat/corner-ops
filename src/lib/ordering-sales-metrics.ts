import { getSql } from "@/lib/db";
import { businessDateOf } from "@/lib/ordering-registers";
import {
  FULFILLMENTS, SALES_CHANNELS, fulfillment, itemMetrics, metricsRange, orderTotals, percentChange, salesChannel, salesSeries,
  type ItemTally, type MenuItemRow, type MetricsOrderRow, type MetricsPeriod, type MetricsPreset, type MetricsRange,
} from "@/lib/sales-metrics";

const BUSINESS = "Corner Deli";
const number = (value: unknown) => Number(value || 0);
const inPeriod = (value: unknown, period: MetricsPeriod) => { const at = new Date(value as string).getTime(); return at >= Date.parse(period.from) && at < Date.parse(period.to); };

// Orders that count as sales: rung in, not voided or cancelled (same rule as the Daily report and Busy times).
// Each item line's net: what is left after item cancellations, scaled so the lines of an order add up to its
// net sales (total less tips and delivery fees), which spreads order discounts across the items.
const lines = (from: string, to: string, itemId: string | null) => getSql()`
  WITH lines AS (
    SELECT i.item_id,o.created_at order_at,(i.quantity-i.cancelled_quantity) qty,
      i.line_total_cents::numeric*(i.quantity-i.cancelled_quantity)/i.quantity live,
      GREATEST(0,o.total_cents-o.tip_cents-o.delivery_fee_cents)::numeric net,
      SUM(i.line_total_cents::numeric*(i.quantity-i.cancelled_quantity)/i.quantity) OVER (PARTITION BY o.id) order_live
    FROM ordering_order_items i JOIN ordering_orders o ON o.id=i.order_id
    WHERE o.business=${BUSINESS} AND o.status NOT IN('draft','cancelled') AND o.voided_at IS NULL
      AND o.created_at>=${from} AND o.created_at<${to}
  )
  SELECT item_id::text item_id,order_at,qty,CASE WHEN order_live>0 THEN live*net/order_live ELSE 0 END cents
  FROM lines WHERE qty>0 AND (${itemId}::uuid IS NULL OR item_id=${itemId}::uuid)`;

const tally = (rows: Record<string, unknown>[], period: MetricsPeriod) => {
  const out = new Map<string, { quantity: number; cents: number }>();
  for (const row of rows) {
    if (!inPeriod(row.order_at, period)) continue;
    const slot = out.get(String(row.item_id)) || { quantity: 0, cents: 0 };
    slot.quantity += number(row.qty); slot.cents += number(row.cents);
    out.set(String(row.item_id), slot);
  }
  return out;
};
const earliest = (range: MetricsRange) => (range.previous.from < range.from ? range.previous.from : range.from);

async function menuItems() {
  const rows = await getSql()`
    SELECT m.id::text id,m.name,m.available,m.active AND c.active active,
      COALESCE(NULLIF(p.display_name,''),p.name,NULLIF(c.display_name,''),c.name,'Other') category
    FROM ordering_menu_items m JOIN ordering_menu_categories c ON c.id=m.category_id LEFT JOIN ordering_menu_categories p ON p.id=c.parent_id
    WHERE m.business=${BUSINESS}`;
  return rows.map((row) => ({ id: String(row.id), name: String(row.name), category: String(row.category), available: Boolean(row.available), active: Boolean(row.active) }));
}

export type SalesMetricsInput = { preset: MetricsPreset; start?: string; end?: string; now?: Date };
const resolve = (input: SalesMetricsInput) => { const now = input.now || new Date(); return metricsRange({ preset: input.preset, start: input.start, end: input.end, today: businessDateOf(now), now }); };

/** Everything on the Sales metrics page for one range, with the period before it for comparison. */
export async function salesMetrics(input: SalesMetricsInput) {
  const range = resolve(input), sql = getSql();
  const [orders, itemLines, menu, tenders] = await Promise.all([
    sql`SELECT created_at,source,service_type,caller_phone,three_cx_call_id,total_cents,tip_cents,delivery_fee_cents
      FROM ordering_orders WHERE business=${BUSINESS} AND status NOT IN('draft','cancelled') AND voided_at IS NULL
        AND created_at>=${earliest(range)} AND created_at<${range.to}`,
    lines(earliest(range), range.to, null),
    menuItems(),
    sql`SELECT t.tender_type,
        COALESCE(SUM(CASE WHEN t.transaction_type='payment' THEN t.amount_cents ELSE 0 END),0)::bigint paid_cents,
        COALESCE(SUM(CASE WHEN t.transaction_type IN('refund','void') THEN t.amount_cents ELSE 0 END),0)::bigint reversed_cents,
        COUNT(DISTINCT CASE WHEN t.transaction_type='payment' THEN t.order_id END)::int orders
      FROM ordering_payment_transactions t JOIN ordering_orders o ON o.id=t.order_id
      WHERE o.business=${BUSINESS} AND o.status NOT IN('draft','cancelled') AND o.voided_at IS NULL AND t.status='approved'
        AND o.created_at>=${range.from} AND o.created_at<${range.to}
      GROUP BY 1`,
  ]);
  const rows = orders as unknown as MetricsOrderRow[];
  const current = rows.filter((row) => inPeriod(row.created_at, range)), previous = rows.filter((row) => inPeriod(row.created_at, range.previous));
  const itemsNow = tally(itemLines, range), itemsBefore = tally(itemLines, range.previous);
  const sumQuantity = (map: Map<string, { quantity: number }>) => [...map.values()].reduce((sum, slot) => sum + slot.quantity, 0);
  const totals = orderTotals(current, sumQuantity(itemsNow)), before = orderTotals(previous, sumQuantity(itemsBefore));
  const byId = new Map(menu.map((item) => [item.id, item]));
  const asTallies = (map: Map<string, { quantity: number; cents: number }>): ItemTally[] => [...map.entries()].map(([id, slot]) => ({ id, name: byId.get(id)?.name || "Unknown item", category: byId.get(id)?.category || "Other", quantity: slot.quantity, netCents: Math.round(slot.cents) }));
  const activeMenu: MenuItemRow[] = menu.filter((item) => item.active);
  const channelSplit = <K extends string>(keys: readonly K[], keyOf: (row: MetricsOrderRow) => K) => keys.map((key) => {
    const now = current.filter((row) => keyOf(row) === key), then = previous.filter((row) => keyOf(row) === key);
    const a = orderTotals(now, 0), b = orderTotals(then, 0);
    return { key, orders: a.orders, netCents: a.netCents, prevOrders: b.orders, prevNetCents: b.netCents };
  });
  const tenderRows = tenders.map((row) => ({ tender: String(row.tender_type), cents: number(row.paid_cents) - number(row.reversed_cents), orders: number(row.orders) })).filter((row) => row.cents !== 0 || row.orders).sort((a, b) => b.cents - a.cents);
  return {
    range,
    kpis: (["netCents", "orders", "avgTicketCents", "itemsSold"] as const).map((key) => ({ key, value: totals[key], previous: before[key], change: percentChange(totals[key], before[key]) })),
    totals, previousTotals: before,
    channels: channelSplit(SALES_CHANNELS, salesChannel),
    fulfillment: channelSplit(FULFILLMENTS, fulfillment),
    series: salesSeries(rows.map((row) => ({ at: row.created_at, cents: Math.max(0, number(row.total_cents) - number(row.tip_cents) - number(row.delivery_fee_cents)), count: 1 })), range),
    ...itemMetrics(asTallies(itemsNow), asTallies(itemsBefore), activeMenu),
    payments: { tenders: tenderRows, unpaidCents: Math.max(0, totals.grossCents - tenderRows.reduce((sum, row) => sum + row.cents, 0)) },
    generatedAt: new Date().toISOString(),
  };
}

/** When one menu item sells over the range: trend against the period before, hour of day and weekday. */
export async function itemSalesMetrics(input: SalesMetricsInput & { itemId: string }) {
  const range = resolve(input);
  const [rows, menu] = await Promise.all([lines(earliest(range), range.to, input.itemId), menuItems()]);
  const item = menu.find((entry) => entry.id === input.itemId);
  const series = salesSeries(rows.map((row) => ({ at: row.order_at as string, cents: Math.round(number(row.cents)), count: number(row.qty) })), range);
  const now = tally(rows, range).get(input.itemId), before = tally(rows, range.previous).get(input.itemId);
  return {
    range, item: { id: input.itemId, name: item?.name || "Unknown item", category: item?.category || "Other" },
    quantity: now?.quantity || 0, netCents: Math.round(now?.cents || 0), prevQuantity: before?.quantity || 0, prevNetCents: Math.round(before?.cents || 0),
    series,
  };
}

export type SalesMetrics = Awaited<ReturnType<typeof salesMetrics>>;
export type ItemSalesMetrics = Awaited<ReturnType<typeof itemSalesMetrics>>;

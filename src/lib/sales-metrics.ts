// Sales metrics: what sold, when, and how it compares with the period before.
// Pure math, no database. Every bucket uses the store clock (America/New_York)
// and the 4 AM business day, so a 1 AM sale belongs to the night before.
import { businessDayBoundary, storeWallClockToUtc } from "./business-day";
import { storeClock, weekdayOf } from "./busy-times";

export const METRICS_PRESETS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_90", "custom"] as const;
export type MetricsPreset = (typeof METRICS_PRESETS)[number];
export type MetricsGrain = "hour" | "day" | "week";
export const MAX_CUSTOM_DAYS = 366;

/** Business hours run 4 AM to 4 AM: hour index 0 is 4 AM, 23 is 3 AM the next morning. */
export const HOUR_INDEXES = Array.from({ length: 24 }, (_, index) => index);
export const hourOfIndex = (index: number) => (index + 4) % 24;

type Stamp = string | Date;
const DAY_MS = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (start: string, end: string) => Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY_MS);
const monthStart = (date: string, months = 0) => {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 10);
};
const monthEnd = (date: string) => shift(monthStart(date, 1), -1);
const validDate = (value: string | undefined) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().startsWith(value));

export type MetricsPeriod = { start: string; end: string; from: string; to: string };
export type MetricsRange = MetricsPeriod & { preset: MetricsPreset; today: string; grain: MetricsGrain; lengthDays: number; partial: boolean; previous: MetricsPeriod };

export class MetricsRangeError extends Error {}

/**
 * First and last business date of a preset, the instants it covers (cut off at
 * `now` while it is still running) and the period before it. The period before
 * is the same length; while the range is still running it is cut off at the
 * same point, so a Wednesday-so-far week compares with Monday-Wednesday last week.
 * Months compare with the calendar month before.
 */
export function metricsRange(input: { preset: MetricsPreset; today: string; now: Date; start?: string; end?: string }): MetricsRange {
  const { preset, today } = input;
  const monday = shift(today, -weekdayOf(today));
  let start: string, end: string;
  if (preset === "today") start = end = today;
  else if (preset === "yesterday") start = end = shift(today, -1);
  else if (preset === "this_week") { start = monday; end = shift(monday, 6); }
  else if (preset === "last_week") { start = shift(monday, -7); end = shift(monday, -1); }
  else if (preset === "this_month") { start = monthStart(today); end = monthEnd(today); }
  else if (preset === "last_month") { start = monthStart(today, -1); end = monthEnd(start); }
  else if (preset === "last_90") { start = shift(today, -89); end = today; }
  else if (preset === "custom") {
    if (!validDate(input.start) || !validDate(input.end)) throw new MetricsRangeError("Pick a start and end date.");
    start = input.start as string; end = input.end as string;
    if (start > end) throw new MetricsRangeError("The start date must be on or before the end date.");
    if (daysBetween(start, end) + 1 > MAX_CUSTOM_DAYS) throw new MetricsRangeError(`Pick ${MAX_CUSTOM_DAYS} days or fewer.`);
  } else throw new MetricsRangeError("Pick a date range.");
  const lengthDays = daysBetween(start, end) + 1;
  const fromAt = businessDayBoundary(start), fullTo = businessDayBoundary(end, true);
  const toAt = new Date(Math.min(fullTo.getTime(), Math.max(fromAt.getTime(), input.now.getTime())));
  const partial = toAt < fullTo;
  const monthly = preset === "this_month" || preset === "last_month";
  const prevStart = monthly ? monthStart(start, -1) : shift(start, -lengthDays);
  const prevEnd = monthly ? monthEnd(prevStart) : shift(start, -1);
  const prevFrom = businessDayBoundary(prevStart), prevFullTo = businessDayBoundary(prevEnd, true);
  // Cut the period before at the same store-clock point (same day offset, same time of day), so a DST change doesn't shift it an hour.
  let prevTo = prevFullTo;
  if (partial) {
    const reached = storeClock(toAt), [year, month, day] = shift(prevStart, daysBetween(start, reached.businessDate)).split("-").map(Number);
    prevTo = new Date(Math.max(prevFrom.getTime(), Math.min(prevFullTo.getTime(), storeWallClockToUtc(year, month, day, Math.floor(reached.minute / 60), reached.minute % 60).getTime())));
  }
  return {
    preset, today, start, end, from: fromAt.toISOString(), to: toAt.toISOString(), partial, lengthDays,
    grain: lengthDays === 1 ? "hour" : lengthDays <= 62 ? "day" : "week",
    previous: { start: prevStart, end: prevEnd, from: prevFrom.toISOString(), to: prevTo.toISOString() },
  };
}

// ---------------------------------------------------------------------------
// Time series: sales over the range, by hour of day, by weekday, hour x weekday.

/** One sale: an order (count 1) or an item line (count = quantity sold). */
export type SaleEvent = { at: Stamp; cents: number; count: number };
export type SeriesCell = { cents: number; count: number };
export type TrendBucket = SeriesCell & { key: string; label: string; future: boolean; previous: SeriesCell | null };
export type SalesSeries = {
  trend: TrendBucket[];
  byHour: Array<SeriesCell & { hour: number }>;
  byWeekday: Array<SeriesCell & { weekday: number; days: number }>;
  heatmap: Array<{ weekday: number; hours: Array<SeriesCell & { hour: number }> }>;
};
const cell = (): SeriesCell => ({ cents: 0, count: 0 });
const add = (target: SeriesCell, event: { cents: number; count: number }) => { target.cents += event.cents; target.count += event.count; };
const at = (value: Stamp) => (value instanceof Date ? value : new Date(value));
const shortDay = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${date}T12:00:00Z`));
const clockLabel = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "a" : "p"}`;

/** Where an instant falls on a range's trend: hour of the business day, day of the range, or 7-day block of the range. */
function bucketOf(clock: { businessDate: string; minute: number }, start: string, grain: MetricsGrain) {
  if (grain === "hour") return Math.min(23, Math.max(0, Math.floor(clock.minute / 60) - 4));
  const offset = daysBetween(start, clock.businessDate);
  return grain === "day" ? offset : Math.floor(offset / 7);
}

function trendShape(range: MetricsRange): Array<{ key: string; label: string }> {
  if (range.grain === "hour") return HOUR_INDEXES.map((index) => ({ key: String(hourOfIndex(index)), label: clockLabel(hourOfIndex(index)) }));
  if (range.grain === "day") return Array.from({ length: range.lengthDays }, (_, offset) => {
    const day = shift(range.start, offset);
    return { key: day, label: shortDay(day, { weekday: "short", month: "short", day: "numeric" }) };
  });
  return Array.from({ length: Math.ceil(range.lengthDays / 7) }, (_, block) => {
    const first = shift(range.start, block * 7), last = [shift(first, 6), range.end].sort()[0];
    return { key: first, label: `${shortDay(first, { month: "short", day: "numeric" })} – ${shortDay(last, { month: "short", day: "numeric" })}` };
  });
}

const inPeriod = (when: Date, period: MetricsPeriod) => when.getTime() >= Date.parse(period.from) && when.getTime() < Date.parse(period.to);

/**
 * Trend (with the previous period lined up bucket by bucket), hour of day,
 * weekday and the hour x weekday grid. Events outside the range only feed the
 * previous-period line. Weekday totals carry how many of that weekday the range
 * has had, so a page can show averages.
 */
export function salesSeries(events: readonly SaleEvent[], range: MetricsRange): SalesSeries {
  const shape = trendShape(range);
  const current = shape.map(cell), previous = shape.map(cell);
  const byHour = HOUR_INDEXES.map(cell), byWeekday = Array.from({ length: 7 }, cell);
  const heat = Array.from({ length: 7 }, () => HOUR_INDEXES.map(cell));
  for (const event of events) {
    const when = at(event.at), clock = storeClock(when);
    if (inPeriod(when, range)) {
      const bucket = bucketOf(clock, range.start, range.grain), hour = Math.min(23, Math.max(0, Math.floor(clock.minute / 60) - 4)), weekday = weekdayOf(clock.businessDate);
      if (current[bucket]) add(current[bucket], event);
      add(byHour[hour], event); add(byWeekday[weekday], event); add(heat[weekday][hour], event);
    } else if (inPeriod(when, range.previous)) {
      const bucket = bucketOf(clock, range.previous.start, range.grain);
      if (previous[bucket]) add(previous[bucket], event);
    }
  }
  // How many of each weekday the range has started (for per-day averages).
  const dayCounts = Array.from({ length: 7 }, () => 0);
  for (let day = range.start; day <= range.end && day <= range.today; day = shift(day, 1)) dayCounts[weekdayOf(day)] += 1;
  // The previous line only reaches as far into its period as the current range has run.
  const elapsed = range.partial ? bucketOf(storeClock(new Date(Math.max(Date.parse(range.from), Date.parse(range.to) - 1))), range.start, range.grain) + 1 : shape.length;
  const prevLength = daysBetween(range.previous.start, range.previous.end) + 1;
  const prevBuckets = range.grain === "hour" ? shape.length : range.grain === "day" ? prevLength : Math.ceil(prevLength / 7);
  return {
    trend: shape.map((bucket, index) => ({ ...bucket, ...current[index], future: index >= elapsed, previous: index < prevBuckets && index < elapsed ? previous[index] : null })),
    byHour: byHour.map((value, index) => ({ hour: hourOfIndex(index), ...value })),
    byWeekday: byWeekday.map((value, weekday) => ({ weekday, days: dayCounts[weekday], ...value })),
    heatmap: heat.map((hours, weekday) => ({ weekday, hours: hours.map((value, index) => ({ hour: hourOfIndex(index), ...value })) })),
  };
}

// ---------------------------------------------------------------------------
// Orders: KPI tiles and channel splits.

export type MetricsOrderRow = {
  created_at: Stamp; source: string; service_type: string; caller_phone?: string | null; three_cx_call_id?: string | null;
  total_cents: number | string | null; tip_cents: number | string | null; delivery_fee_cents: number | string | null;
};
export const SALES_CHANNELS = ["counter", "phone", "ai_phone", "online", "kiosk"] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];
export const FULFILLMENTS = ["pickup", "delivery", "dine_in"] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];

/** Online, AI phone and kiosk by source; a POS order with a call behind it is a phone order, else a counter sale. */
export function salesChannel(row: Pick<MetricsOrderRow, "source" | "caller_phone" | "three_cx_call_id">): SalesChannel {
  if (row.source === "web") return "online";
  if (row.source === "ai_phone") return "ai_phone";
  if (row.source === "kiosk") return "kiosk";
  return String(row.caller_phone || "").trim() || String(row.three_cx_call_id || "").trim() ? "phone" : "counter";
}
export function fulfillment(row: Pick<MetricsOrderRow, "service_type">): Fulfillment {
  if (row.service_type === "delivery" || row.service_type === "no_contact_delivery") return "delivery";
  if (row.service_type === "dine_in" || row.service_type === "bar") return "dine_in";
  return "pickup";
}

const cents = (value: unknown) => Number(value || 0);
/** Net sales: the order total (prices include tax) after voids, item cancellations and discounts, less tips and delivery fees. */
export const orderNetCents = (row: MetricsOrderRow) => Math.max(0, cents(row.total_cents) - cents(row.tip_cents) - cents(row.delivery_fee_cents));

export type OrderTotals = { netCents: number; grossCents: number; tipsCents: number; deliveryFeesCents: number; orders: number; avgTicketCents: number; itemsSold: number };
export function orderTotals(rows: readonly MetricsOrderRow[], itemsSold: number): OrderTotals {
  const netCents = rows.reduce((sum, row) => sum + orderNetCents(row), 0);
  return {
    netCents, orders: rows.length, itemsSold,
    grossCents: rows.reduce((sum, row) => sum + cents(row.total_cents), 0),
    tipsCents: rows.reduce((sum, row) => sum + cents(row.tip_cents), 0),
    deliveryFeesCents: rows.reduce((sum, row) => sum + cents(row.delivery_fee_cents), 0),
    avgTicketCents: rows.length ? Math.round(netCents / rows.length) : 0,
  };
}

export function splitBy<K extends string>(rows: readonly MetricsOrderRow[], keys: readonly K[], keyOf: (row: MetricsOrderRow) => K) {
  const out = Object.fromEntries(keys.map((key) => [key, { orders: 0, netCents: 0 }])) as Record<K, { orders: number; netCents: number }>;
  for (const row of rows) { const slot = out[keyOf(row)]; slot.orders += 1; slot.netCents += orderNetCents(row); }
  return out;
}

/** Percent change, or null when there is nothing to compare with. */
export const percentChange = (current: number, previous: number) => (previous ? Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10 : null);

// ---------------------------------------------------------------------------
// Items: rankings, categories and menu items that didn't sell.

export type ItemTally = { id: string; name: string; category: string; quantity: number; netCents: number };
export type MenuItemRow = { id: string; name: string; category: string; available: boolean };
export type ItemMetric = ItemTally & { prevQuantity: number; prevNetCents: number };

/** Every item sold in the range with its previous-period numbers, best revenue first; categories; active menu items that sold none. */
export function itemMetrics(current: readonly ItemTally[], previous: readonly ItemTally[], menu: readonly MenuItemRow[]) {
  const before = new Map(previous.map((item) => [item.id, item]));
  const sold = current.filter((item) => item.quantity > 0);
  const items: ItemMetric[] = sold
    .map((item) => ({ ...item, prevQuantity: before.get(item.id)?.quantity || 0, prevNetCents: before.get(item.id)?.netCents || 0 }))
    .sort((a, b) => b.netCents - a.netCents || b.quantity - a.quantity || a.name.localeCompare(b.name));
  const categories = new Map<string, { name: string; quantity: number; netCents: number; items: number }>();
  for (const item of sold) {
    const slot = categories.get(item.category) || { name: item.category, quantity: 0, netCents: 0, items: 0 };
    slot.quantity += item.quantity; slot.netCents += item.netCents; slot.items += 1;
    categories.set(item.category, slot);
  }
  const soldIds = new Set(sold.map((item) => item.id));
  return {
    items,
    categories: [...categories.values()].sort((a, b) => b.netCents - a.netCents),
    zeroSellers: menu.filter((item) => !soldIds.has(item.id)).map((item) => ({ id: item.id, name: item.name, category: item.category, available: item.available })).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
  };
}

/** Top or bottom `count` sellers by quantity or revenue (ties broken by the other measure, then name). */
export function rankItems(items: readonly ItemMetric[], by: "quantity" | "revenue", end: "top" | "bottom", count = 10) {
  const primary = (item: ItemMetric) => (by === "quantity" ? item.quantity : item.netCents), secondary = (item: ItemMetric) => (by === "quantity" ? item.netCents : item.quantity);
  const sorted = [...items].sort((a, b) => primary(b) - primary(a) || secondary(b) - secondary(a) || a.name.localeCompare(b.name));
  return end === "top" ? sorted.slice(0, count) : sorted.reverse().slice(0, count);
}

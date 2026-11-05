import test from "node:test";
import assert from "node:assert/strict";
import { fulfillment, itemMetrics, metricsRange, orderNetCents, orderTotals, percentChange, rankItems, salesChannel, salesSeries, MetricsRangeError, type MetricsOrderRow } from "../src/lib/sales-metrics.js";

// 2026-11-04 is a Wednesday, EST (UTC-5): 17:00Z is noon at the store, and the business day starts at 09:00Z.
const NOW = new Date("2026-11-04T17:00:00Z");
const range = (preset: Parameters<typeof metricsRange>[0]["preset"], extra: { start?: string; end?: string } = {}) => metricsRange({ preset, today: "2026-11-04", now: NOW, ...extra });

test("presets cover the right business dates and compare with the period before", () => {
  const today = range("today");
  assert.deepEqual([today.start, today.end, today.grain, today.partial], ["2026-11-04", "2026-11-04", "hour", true]);
  assert.equal(today.from, "2026-11-04T09:00:00.000Z");
  assert.equal(today.to, NOW.toISOString());
  assert.deepEqual([today.previous.start, today.previous.from, today.previous.to], ["2026-11-03", "2026-11-03T09:00:00.000Z", "2026-11-03T17:00:00.000Z"], "today so far compares with yesterday up to the same time");

  const yesterday = range("yesterday");
  assert.deepEqual([yesterday.start, yesterday.partial, yesterday.to, yesterday.previous.start], ["2026-11-03", false, "2026-11-04T09:00:00.000Z", "2026-11-02"]);

  const week = range("this_week");
  assert.deepEqual([week.start, week.end, week.grain, week.previous.start, week.previous.end], ["2026-11-02", "2026-11-08", "day", "2026-10-26", "2026-11-01"]);
  assert.equal(week.previous.to, "2026-10-28T16:00:00.000Z", "Monday-to-Wednesday noon (EDT then) against the same stretch last week");

  assert.deepEqual([range("last_week").start, range("last_week").end, range("last_week").partial], ["2026-10-26", "2026-11-01", false]);

  const month = range("this_month");
  assert.deepEqual([month.start, month.end, month.previous.start, month.previous.end], ["2026-11-01", "2026-11-30", "2026-10-01", "2026-10-31"]);
  const lastMonth = range("last_month");
  assert.deepEqual([lastMonth.start, lastMonth.end, lastMonth.previous.start, lastMonth.previous.end, lastMonth.grain], ["2026-10-01", "2026-10-31", "2026-09-01", "2026-09-30", "day"]);
  // October 1 starts at 4 AM EDT (08:00Z); November's comparison crosses the DST change cleanly.
  assert.equal(lastMonth.from, "2026-10-01T08:00:00.000Z");

  const ninety = range("last_90");
  assert.deepEqual([ninety.start, ninety.end, ninety.lengthDays, ninety.grain, ninety.previous.end], ["2026-08-07", "2026-11-04", 90, "week", "2026-08-06"]);

  const custom = range("custom", { start: "2026-10-10", end: "2026-10-12" });
  assert.deepEqual([custom.lengthDays, custom.previous.start, custom.previous.end], [3, "2026-10-07", "2026-10-09"]);
  assert.throws(() => range("custom", { start: "2026-10-12", end: "2026-10-10" }), MetricsRangeError);
  assert.throws(() => range("custom", { start: "2026-02-30", end: "2026-03-01" }), MetricsRangeError);
  assert.throws(() => range("custom", { start: "2024-01-01", end: "2026-01-01" }), MetricsRangeError);
});

const order = (row: Partial<MetricsOrderRow>): MetricsOrderRow => ({ created_at: "2026-11-04T16:00:00Z", source: "pos", service_type: "pickup", total_cents: 1000, tip_cents: 0, delivery_fee_cents: 0, ...row });

test("net sales leave out tips and delivery fees; channels and fulfillment", () => {
  assert.equal(orderNetCents(order({ total_cents: 4425, tip_cents: 300, delivery_fee_cents: 400 })), 3725);
  const totals = orderTotals([order({ total_cents: 1800, tip_cents: 400, delivery_fee_cents: 400 }), order({ total_cents: 2000 })], 5);
  assert.deepEqual(totals, { netCents: 3000, grossCents: 3800, tipsCents: 400, deliveryFeesCents: 400, orders: 2, avgTicketCents: 1500, itemsSold: 5 });
  assert.equal(salesChannel(order({ source: "web" })), "online");
  assert.equal(salesChannel(order({ source: "ai_phone" })), "ai_phone");
  assert.equal(salesChannel(order({ caller_phone: "3155550100" })), "phone");
  assert.equal(salesChannel(order({ three_cx_call_id: "x" })), "phone");
  assert.equal(salesChannel(order({})), "counter");
  assert.equal(fulfillment(order({ service_type: "no_contact_delivery" })), "delivery");
  assert.equal(fulfillment(order({ service_type: "bar" })), "dine_in");
  assert.equal(fulfillment(order({ service_type: "curbside" })), "pickup");
  assert.equal(percentChange(150, 100), 50);
  assert.equal(percentChange(5, 0), null);
});

test("series bucket by store clock: hour, weekday, heatmap, and the previous period lined up", () => {
  const week = range("this_week");
  const series = salesSeries([
    { at: "2026-11-02T17:30:00Z", cents: 1000, count: 1 }, // Mon 12:30 PM
    { at: "2026-11-04T06:30:00Z", cents: 500, count: 1 },  // Wed 1:30 AM: still Tuesday's business day
    { at: "2026-10-26T18:00:00Z", cents: 700, count: 1 },  // last Monday 1 PM: previous period
    { at: "2026-10-29T18:00:00Z", cents: 999, count: 1 },  // last Thursday: past the cut-off, not counted
    { at: "2026-11-04T18:00:00Z", cents: 999, count: 1 },  // after now: not counted
  ], week);
  assert.equal(series.trend.length, 7);
  assert.deepEqual(series.trend.slice(0, 3).map((bucket) => [bucket.key, bucket.cents, bucket.previous?.cents ?? null, bucket.future]), [["2026-11-02", 1000, 700, false], ["2026-11-03", 500, 0, false], ["2026-11-04", 0, 0, false]]);
  assert.equal(series.trend[3].future, true);
  assert.equal(series.trend[3].previous, null, "no comparison past the point this week has reached");
  assert.equal(series.byHour.find((cell) => cell.hour === 12)?.cents, 1000);
  assert.equal(series.byHour.find((cell) => cell.hour === 1)?.cents, 500);
  assert.deepEqual(series.byWeekday.slice(0, 3).map((cell) => [cell.cents, cell.days]), [[1000, 1], [500, 1], [0, 1]]);
  assert.equal(series.byWeekday[3].days, 0);
  assert.equal(series.heatmap[1].hours.find((cell) => cell.hour === 1)?.count, 1);

  const today = salesSeries([{ at: "2026-11-04T15:10:00Z", cents: 300, count: 2 }, { at: "2026-11-03T15:20:00Z", cents: 100, count: 1 }], range("today"));
  const ten = today.trend.find((bucket) => bucket.key === "10")!;
  assert.deepEqual([ten.cents, ten.count, ten.previous?.cents], [300, 2, 100]);
  assert.equal(today.trend.find((bucket) => bucket.key === "13")?.future, true);
});

test("item rankings, categories and menu items that sold none", () => {
  const sold = [
    { id: "a", name: "Italian sub", category: "Subs/Wraps", quantity: 10, netCents: 12000 },
    { id: "b", name: "Soda", category: "Drinks & Chips", quantity: 30, netCents: 6000 },
    { id: "c", name: "Cookie", category: "Desserts", quantity: 1, netCents: 200 },
  ];
  const menu = [...sold.map((item) => ({ id: item.id, name: item.name, category: item.category, available: true })), { id: "d", name: "Tuna wrap", category: "Subs/Wraps", available: false }];
  const result = itemMetrics(sold, [{ id: "a", name: "Italian sub", category: "Subs/Wraps", quantity: 8, netCents: 9000 }], menu);
  assert.deepEqual(result.items.map((item) => [item.id, item.prevQuantity]), [["a", 8], ["b", 0], ["c", 0]]);
  assert.deepEqual(result.categories.map((category) => category.name), ["Subs/Wraps", "Drinks & Chips", "Desserts"]);
  assert.deepEqual(result.zeroSellers, [{ id: "d", name: "Tuna wrap", category: "Subs/Wraps", available: false }]);
  assert.deepEqual(rankItems(result.items, "quantity", "top", 2).map((item) => item.id), ["b", "a"]);
  assert.deepEqual(rankItems(result.items, "revenue", "top", 1).map((item) => item.id), ["a"]);
  assert.deepEqual(rankItems(result.items, "quantity", "bottom", 2).map((item) => item.id), ["c", "a"]);
});

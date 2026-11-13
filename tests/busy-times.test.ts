import test from "node:test";
import assert from "node:assert/strict";
import { busyTimes, orderChannel, orderDueAt, storeClock, type BusyOrderRow } from "../src/lib/busy-times.js";

// 2026-11-04 is a Wednesday, EST (UTC-5): 17:00Z is noon at the store.
const order = (row: Partial<BusyOrderRow>): BusyOrderRow => ({ source: "web", service_type: "pickup", total_cents: 1000, created_at: "2026-11-04T16:00:00Z", ...row });

test("due time is the picked time, then the quote, then kitchen, then submitted, then created", () => {
  const base = { created_at: "2026-11-04T15:00:00Z", submitted_at: "2026-11-04T15:05:00Z", kitchen_release_at: "2026-11-04T15:10:00Z", promised_at: "2026-11-04T15:40:00Z" };
  assert.equal(orderDueAt(order({ ...base, scheduled_for: "2026-11-04T23:00:00Z" })).toISOString(), "2026-11-04T23:00:00.000Z");
  assert.equal(orderDueAt(order(base)).toISOString(), "2026-11-04T15:40:00.000Z");
  assert.equal(orderDueAt(order({ ...base, promised_at: null })).toISOString(), "2026-11-04T15:10:00.000Z");
  assert.equal(orderDueAt(order({ ...base, promised_at: null, kitchen_release_at: null })).toISOString(), "2026-11-04T15:05:00.000Z");
  assert.equal(orderDueAt(order({ created_at: base.created_at })).toISOString(), "2026-11-04T15:00:00.000Z");
});

test("delivery, walk-in and pickup", () => {
  assert.equal(orderChannel(order({ service_type: "delivery", source: "pos" })), "delivery");
  assert.equal(orderChannel(order({ service_type: "no_contact_delivery" })), "delivery");
  assert.equal(orderChannel(order({ source: "pos", caller_phone: "" })), "walk_in");
  assert.equal(orderChannel(order({ source: "pos", service_type: "dine_in", caller_phone: "3155550100" })), "walk_in");
  assert.equal(orderChannel(order({ source: "kiosk" })), "walk_in");
  assert.equal(orderChannel(order({ source: "pos", caller_phone: "3155550100" })), "pickup", "phoned-in counter pickup");
  assert.equal(orderChannel(order({ source: "pos", three_cx_call_id: "abc" })), "pickup");
  assert.equal(orderChannel(order({ source: "ai_phone" })), "pickup");
  assert.equal(orderChannel(order({ source: "web", service_type: "curbside" })), "pickup");
});

test("after midnight counts on the business day before, as a late minute", () => {
  assert.deepEqual(storeClock(new Date("2026-11-05T06:30:00Z")), { businessDate: "2026-11-04", minute: 25 * 60 + 30 });
  assert.deepEqual(storeClock(new Date("2026-11-05T09:00:00Z")), { businessDate: "2026-11-05", minute: 4 * 60 });
  assert.deepEqual(storeClock(new Date("2026-07-15T16:15:00Z")), { businessDate: "2026-07-15", minute: 12 * 60 + 15 }, "EDT");
});

test("a day is bucketed by due time, not by when it was rung in or paid", () => {
  const result = busyTimes({
    days: ["2026-11-04"], slotMinutes: 15,
    hoursByDate: { "2026-11-04": [{ open: 11 * 60, close: 21 * 60 }] },
    orders: [
      // Rung in at 9 AM for a 12:10 pickup: counts at 12:00.
      order({ created_at: "2026-11-04T14:00:00Z", scheduled_for: "2026-11-04T17:10:00Z", total_cents: 1500 }),
      order({ source: "pos", service_type: "delivery", created_at: "2026-11-04T16:30:00Z", promised_at: "2026-11-04T17:14:00Z", total_cents: 2500 }),
      order({ source: "pos", created_at: "2026-11-04T17:20:00Z", promised_at: "2026-11-04T17:35:00Z", total_cents: 800 }),
      // Due tomorrow: not this day.
      order({ created_at: "2026-11-04T20:00:00Z", scheduled_for: "2026-11-05T17:00:00Z" }),
    ],
  });
  assert.equal(result.totals.orders, 3);
  assert.equal(result.totals.salesCents, 4800);
  assert.equal(result.storeHoursKnown, true);
  assert.equal(result.slots[0].minute, 11 * 60);
  assert.equal(result.slots[result.slots.length - 1].minute, 21 * 60 - 15);
  const noon = result.slots.find((slot) => slot.minute === 12 * 60)!;
  assert.equal(noon.orders, 2);
  assert.deepEqual(noon.byChannel, { pickup: { orders: 1, salesCents: 1500 }, delivery: { orders: 1, salesCents: 2500 }, walk_in: { orders: 0, salesCents: 0 } });
  assert.equal(result.slots.find((slot) => slot.minute === 12 * 60 + 30)!.byChannel.walk_in.orders, 1);
  assert.deepEqual(result.busiestSlot, { minute: 12 * 60, orders: 2 });
  assert.equal(result.hours.find((hour) => hour.minute === 12 * 60)!.orders, 3);
});

test("the time axis stretches to orders due outside store hours, and falls back to 10–10 with no hours", () => {
  const late = busyTimes({ days: ["2026-11-04"], hoursByDate: { "2026-11-04": [{ open: 11 * 60, close: 21 * 60 }] }, orders: [order({ promised_at: "2026-11-05T06:20:00Z" })] });
  assert.equal(late.startMinute, 11 * 60);
  assert.equal(late.endMinute, 26 * 60);
  assert.equal(late.slots.at(-1)!.minute, 25 * 60 + 0);
  assert.equal(late.slots.at(-1)!.orders, 1);
  const overnight = busyTimes({ days: ["2026-11-04"], hoursByDate: { "2026-11-04": [{ open: 18 * 60, close: 2 * 60 }] }, orders: [] });
  assert.equal(overnight.startMinute, 18 * 60);
  assert.equal(overnight.endMinute, 26 * 60);
  const none = busyTimes({ days: ["2026-11-04"], orders: [] });
  assert.equal(none.storeHoursKnown, false);
  assert.equal(none.startMinute, 10 * 60);
  assert.equal(none.endMinute, 22 * 60);
  assert.equal(none.busiestSlot, null);
});

test("a week fills each day and the weekday-by-hour grid; a month averages each hour over its days", () => {
  const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
  const result = busyTimes({
    days,
    orders: [
      order({ promised_at: "2026-11-02T17:05:00Z" }), // Mon noon
      order({ promised_at: "2026-11-02T17:45:00Z", service_type: "delivery" }), // Mon noon
      order({ promised_at: "2026-11-07T23:30:00Z", total_cents: 3000 }), // Sat 6:30 PM
      order({ promised_at: "2026-11-09T06:30:00Z" }), // Sun 1:30 AM, still Sunday's business day
    ],
  });
  assert.deepEqual(result.byDay.map((day) => day.orders), [2, 0, 0, 0, 0, 1, 1]);
  assert.equal(result.byDay[0].weekday, 0);
  assert.equal(result.heatmap[0].hours.find((cell) => cell.minute === 12 * 60)!.orders, 2);
  assert.equal(result.heatmap[0].hours.find((cell) => cell.minute === 12 * 60)!.byChannel.delivery.orders, 1);
  assert.equal(result.heatmap[5].hours.find((cell) => cell.minute === 18 * 60)!.salesCents, 3000);
  assert.equal(result.heatmap[6].hours.find((cell) => cell.minute === 25 * 60)!.orders, 1);
  assert.deepEqual(result.heatmap.map((row) => row.days), [1, 1, 1, 1, 1, 1, 1]);
  const noon = result.hours.find((hour) => hour.minute === 12 * 60)!;
  assert.equal(noon.orders, 2);
  assert.equal(noon.average.orders, 2 / 7);
  assert.equal(noon.average.salesCents, Math.round(2000 / 7));
});

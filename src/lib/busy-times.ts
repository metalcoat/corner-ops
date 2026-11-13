// Busy times: when the store has to have orders ready, counted by the time each
// order is due to the customer. Paid time is useless here: delivery cash is often
// settled at the end of the driver's shift. Pure math, no database.
import { BUSINESS_DAY_START_HOUR, STORE_TIME_ZONE } from "./business-day";

export type BusyChannel = "pickup" | "delivery" | "walk_in";
export const BUSY_CHANNELS: readonly BusyChannel[] = ["pickup", "delivery", "walk_in"];
export type BusyView = "day" | "week" | "month";

type Stamp = string | Date | null | undefined;
export type BusyOrderRow = {
  source: string;
  service_type: string;
  caller_phone?: string | null;
  three_cx_call_id?: string | null;
  total_cents: number | string | null;
  created_at: Stamp;
  submitted_at?: Stamp;
  kitchen_release_at?: Stamp;
  promised_at?: Stamp;
  scheduled_for?: Stamp;
};
/** Store hours for one business date, as minutes after midnight; a close at or before the open runs past midnight. */
export type BusyWindow = { open: number; close: number };

const valid = (value: Stamp) => {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

/**
 * When the customer expects the order: the time they picked for a scheduled order,
 * else the quoted ready/delivery time (ASAP orders get one when they're placed),
 * else when it went to the kitchen, else when it was rung in.
 * Keep in step with BUSY_DUE_AT_SQL.
 */
export function orderDueAt(row: BusyOrderRow): Date {
  return valid(row.scheduled_for) || valid(row.promised_at) || valid(row.kitchen_release_at) || valid(row.submitted_at) || valid(row.created_at) || new Date(0);
}
export const BUSY_DUE_AT_SQL = "COALESCE(scheduled_for,promised_at,kitchen_release_at,submitted_at,created_at)";

/** Delivery is delivery; counter, kiosk and dine-in orders with no phone call are walk-ins; everything else is pickup. */
export function orderChannel(row: BusyOrderRow): BusyChannel {
  const service = String(row.service_type || "");
  if (service === "delivery" || service === "no_contact_delivery") return "delivery";
  if (service === "dine_in" || service === "bar" || row.source === "kiosk") return "walk_in";
  if (row.source === "pos" && !String(row.caller_phone || "").trim() && !String(row.three_cx_call_id || "").trim()) return "walk_in";
  return "pickup";
}

const wallClock = new Intl.DateTimeFormat("en-US", { timeZone: STORE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** Monday is 0. */
export const weekdayOf = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

/** Business date of an instant and its minute on that date's clock: 1:30 AM belongs to the day before, as minute 1530. */
export function storeClock(at: Date): { businessDate: string; minute: number } {
  const values = Object.fromEntries(wallClock.formatToParts(at).map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`, minute = Number(values.hour) * 60 + Number(values.minute);
  return minute < BUSINESS_DAY_START_HOUR * 60 ? { businessDate: shiftDate(date, -1), minute: minute + 1440 } : { businessDate: date, minute };
}

type ChannelTally = { orders: number; salesCents: number };
export type BusyTally = ChannelTally & { byChannel: Record<BusyChannel, ChannelTally> };
const emptyTally = (): BusyTally => ({ orders: 0, salesCents: 0, byChannel: { pickup: { orders: 0, salesCents: 0 }, delivery: { orders: 0, salesCents: 0 }, walk_in: { orders: 0, salesCents: 0 } } });
const add = (tally: BusyTally, channel: BusyChannel, cents: number) => {
  tally.orders += 1; tally.salesCents += cents;
  tally.byChannel[channel].orders += 1; tally.byChannel[channel].salesCents += cents;
};
const scale = (tally: BusyTally, by: number): BusyTally => ({
  orders: tally.orders / by, salesCents: Math.round(tally.salesCents / by),
  byChannel: Object.fromEntries(BUSY_CHANNELS.map((channel) => [channel, { orders: tally.byChannel[channel].orders / by, salesCents: Math.round(tally.byChannel[channel].salesCents / by) }])) as BusyTally["byChannel"],
});

const DEFAULT_HOURS: BusyWindow = { open: 10 * 60, close: 22 * 60 };

/**
 * Orders per time slot for one day, per day, per hour (with the average over the
 * days counted) and per weekday-by-hour. Only orders due on one of `days` count.
 * The time axis covers store hours and stretches to any order due outside them.
 */
export function busyTimes(input: { days: readonly string[]; orders: readonly BusyOrderRow[]; hoursByDate?: Readonly<Record<string, readonly BusyWindow[]>>; slotMinutes?: 15 | 30 }) {
  const slotMinutes = input.slotMinutes || 30;
  const daySet = new Set(input.days);
  const placed = input.orders.flatMap((row) => {
    const clock = storeClock(orderDueAt(row));
    return daySet.has(clock.businessDate) ? [{ ...clock, channel: orderChannel(row), cents: Number(row.total_cents || 0) }] : [];
  });

  const windows = input.days.flatMap((day) => input.hoursByDate?.[day] || []).map((window) => ({ open: window.open, close: window.close <= window.open ? window.close + 1440 : window.close }));
  const storeHoursKnown = windows.length > 0;
  const span = storeHoursKnown ? windows : [DEFAULT_HOURS];
  let first = Math.min(...span.map((window) => window.open)), last = Math.max(...span.map((window) => window.close));
  for (const order of placed) { first = Math.min(first, order.minute); last = Math.max(last, order.minute + 1); }
  const axis = (step: number) => {
    const marks: number[] = [];
    for (let minute = Math.floor(first / step) * step; minute < Math.ceil(last / step) * step; minute += step) marks.push(minute);
    return marks;
  };

  const slotMarks = axis(slotMinutes), hourMarks = axis(60);
  const slots = new Map(slotMarks.map((minute) => [minute, emptyTally()]));
  const hours = new Map(hourMarks.map((minute) => [minute, emptyTally()]));
  const byDay = new Map(input.days.map((day) => [day, emptyTally()]));
  const heat = Array.from({ length: 7 }, () => new Map(hourMarks.map((minute) => [minute, emptyTally()])));
  const totals = emptyTally();
  for (const order of placed) {
    const slot = Math.floor(order.minute / slotMinutes) * slotMinutes, hour = Math.floor(order.minute / 60) * 60;
    for (const tally of [totals, byDay.get(order.businessDate)!, slots.get(slot)!, hours.get(hour)!, heat[weekdayOf(order.businessDate)].get(hour)!]) add(tally, order.channel, order.cents);
  }

  const dayCount = Math.max(1, input.days.length);
  const weekdayCounts = Array.from({ length: 7 }, (_, weekday) => input.days.filter((day) => weekdayOf(day) === weekday).length);
  const slotList = slotMarks.map((minute) => ({ minute, ...slots.get(minute)! }));
  const busiest = (list: Array<{ minute: number; orders: number }>) => list.reduce<{ minute: number; orders: number } | null>((best, row) => row.orders > (best?.orders || 0) ? { minute: row.minute, orders: row.orders } : best, null);
  const hourList = hourMarks.map((minute) => ({ minute, ...hours.get(minute)!, average: scale(hours.get(minute)!, dayCount) }));
  return {
    slotMinutes, storeHoursKnown, startMinute: hourMarks[0], endMinute: hourMarks[hourMarks.length - 1] + 60,
    totals,
    slots: slotList,
    hours: hourList,
    byDay: input.days.map((businessDate) => ({ businessDate, weekday: weekdayOf(businessDate), ...byDay.get(businessDate)! })),
    heatmap: heat.map((row, weekday) => ({ weekday, days: weekdayCounts[weekday], hours: hourMarks.map((minute) => ({ minute, ...row.get(minute)! })) })),
    busiestSlot: busiest(slotList),
    busiestHour: busiest(hourList),
  };
}

export type BusyTimes = ReturnType<typeof busyTimes>;

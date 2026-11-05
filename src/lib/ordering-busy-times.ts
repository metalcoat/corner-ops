import { getSql } from "@/lib/db";
import { businessDayBoundary } from "@/lib/business-day";
import { busyTimes, type BusyOrderRow, type BusyWindow } from "@/lib/busy-times";
import { managerReportRange, type ManagerReportView } from "@/lib/ordering-manager-report";
import { businessDateOf } from "@/lib/ordering-registers";

const BUSINESS = "Corner Deli";
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const minutes = (value: unknown) => { const [hours, mins] = String(value || "0:0").split(":").map(Number); return (hours || 0) * 60 + (mins || 0); };

/** Store hours for each business date: regular weekly hours, or that date's closure or custom hours. */
async function storeHours(start: string, end: string, days: string[]) {
  const sql = getSql();
  const [regular, exceptions] = await Promise.all([
    sql`SELECT weekday,opens_at::text opens_at,closes_at::text closes_at FROM ordering_business_hours WHERE business=${BUSINESS} AND active AND accepts_orders`,
    sql`SELECT business_date::text business_date,status,opens_at::text opens_at,closes_at::text closes_at FROM ordering_business_hour_exceptions WHERE business=${BUSINESS} AND business_date BETWEEN ${start}::date AND ${end}::date`,
  ]);
  const hoursByDate: Record<string, BusyWindow[]> = {};
  for (const day of days) {
    const exception = exceptions.find((row) => String(row.business_date).slice(0, 10) === day);
    if (exception?.status === "closed") hoursByDate[day] = [];
    else if (exception?.status === "custom_hours" && exception.opens_at && exception.closes_at) hoursByDate[day] = [{ open: minutes(exception.opens_at), close: minutes(exception.closes_at) }];
    else hoursByDate[day] = regular.filter((row) => Number(row.weekday) === new Date(`${day}T12:00:00Z`).getUTCDay()).map((row) => ({ open: minutes(row.opens_at), close: minutes(row.closes_at) }));
  }
  return hoursByDate;
}

/** When orders were due to customers over a day, week or month. Voided and cancelled orders don't count. */
export async function busyTimesReport(input: { view: ManagerReportView; date: string; slotMinutes?: 15 | 30; now?: Date }) {
  const now = input.now || new Date(), today = businessDateOf(now);
  const range = managerReportRange(input.view, input.date);
  const days: string[] = [];
  for (let day = range.start; day <= range.end && day <= today; day = shift(day, 1)) days.push(day);
  const from = businessDayBoundary(range.start).toISOString(), to = businessDayBoundary(range.end, true).toISOString();
  // Due time below matches orderDueAt / BUSY_DUE_AT_SQL.
  const [orders, hoursByDate] = await Promise.all([
    getSql()`SELECT source,service_type,caller_phone,three_cx_call_id,total_cents,created_at,submitted_at,kitchen_release_at,promised_at,scheduled_for
      FROM ordering_orders
      WHERE business=${BUSINESS} AND status NOT IN('draft','cancelled') AND voided_at IS NULL
        AND COALESCE(scheduled_for,promised_at,kitchen_release_at,submitted_at,created_at)>=${from}
        AND COALESCE(scheduled_for,promised_at,kitchen_release_at,submitted_at,created_at)<${to}`,
    storeHours(range.start, range.end, days),
  ]);
  return {
    view: input.view, date: input.date, today, start: range.start, end: range.end,
    ...busyTimes({ days, orders: orders as BusyOrderRow[], hoursByDate, slotMinutes: input.slotMinutes }),
    generatedAt: now.toISOString(),
  };
}

export type BusyTimesReport = Awaited<ReturnType<typeof busyTimesReport>>;

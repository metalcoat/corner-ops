import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";

type SettingsRow = {
  timezone: string;
  after_hours_ai_enabled: boolean;
  allow_future_orders_when_closed: boolean;
};

type HoursRow = {
  weekday: number;
  opens_at: string;
  closes_at: string;
  accepts_orders: boolean;
  sort_order: number;
};

type ExceptionRow = {
  business_date: string | Date;
  status: "closed" | "custom_hours";
  opens_at: string | null;
  closes_at: string | null;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const weekdayMap: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zonedParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdayMap[values.weekday] ?? 0,
  };
}

function dateKey(parts: Pick<LocalParts, "year" | "month" | "day">): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function addLocalDays(parts: Pick<LocalParts, "year" | "month" | "day">, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function timeMinutes(value: string): number {
  const [hours, minutes] = String(value).split(":").map(Number);
  return Math.max(0, Math.min(1439, (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0)));
}

function localDateTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  minuteOfDay: number;
  timeZone: string;
}): Date {
  const hour = Math.floor(input.minuteOfDay / 60);
  const minute = input.minuteOfDay % 60;
  const desiredWallMs = Date.UTC(input.year, input.month - 1, input.day, hour, minute, 0);
  let guess = desiredWallMs;

  // Iteratively correct the UTC guess until its wall-clock representation in
  // the target zone matches the requested local date/time. This avoids adding
  // another date library just for ordering-hour calculations.
  for (let i = 0; i < 4; i += 1) {
    const observed = zonedParts(new Date(guess), input.timeZone);
    const observedWallMs = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
    );
    const delta = desiredWallMs - observedWallMs;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

function intervalContainsMinute(openMinute: number, closeMinute: number, currentMinute: number): boolean {
  if (openMinute < closeMinute) return currentMinute >= openMinute && currentMinute <= closeMinute;
  return currentMinute >= openMinute || currentMinute <= closeMinute;
}

function weekdayForDate(parts: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function normalizeDateValue(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export type OrderingAvailability = {
  openNow: boolean;
  nextOpenAt: Date | null;
  timezone: string;
  afterHoursAiEnabled: boolean;
  allowFutureOrdersWhenClosed: boolean;
};

export async function getOrderingAvailability(input: {
  business: OrderingBusiness;
  now?: Date;
  searchDays?: number;
}): Promise<OrderingAvailability> {
  await ensureOrderingTimingSchema();
  const sql = getSql();
  const now = input.now ?? new Date();
  const settingsRows = (await sql`
    SELECT timezone, after_hours_ai_enabled, allow_future_orders_when_closed
    FROM ordering_business_ordering_settings
    WHERE business = ${input.business}
    LIMIT 1
  `) as SettingsRow[];
  const settings = settingsRows[0] || {
    timezone: "America/New_York",
    after_hours_ai_enabled: true,
    allow_future_orders_when_closed: true,
  };
  const localNow = zonedParts(now, settings.timezone);
  const searchDays = Math.max(1, Math.min(60, Math.trunc(input.searchDays ?? 14)));
  const lastLocalDate = addLocalDays(localNow, searchDays);

  const regularRows = (await sql`
    SELECT weekday, opens_at::TEXT, closes_at::TEXT, accepts_orders, sort_order
    FROM ordering_business_hours
    WHERE business = ${input.business} AND active = TRUE
    ORDER BY weekday, sort_order, opens_at
  `) as HoursRow[];
  const exceptionRows = (await sql`
    SELECT business_date, status, opens_at::TEXT, closes_at::TEXT
    FROM ordering_business_hour_exceptions
    WHERE business = ${input.business}
      AND business_date BETWEEN ${dateKey(localNow)}::DATE AND ${dateKey(lastLocalDate)}::DATE
    ORDER BY business_date
  `) as ExceptionRow[];

  const exceptions = new Map(exceptionRows.map((row) => [normalizeDateValue(row.business_date), row]));

  function intervalsForDate(date: { year: number; month: number; day: number }): Array<{ open: number; close: number }> {
    const key = dateKey(date);
    const exception = exceptions.get(key);
    if (exception?.status === "closed") return [];
    if (exception?.status === "custom_hours" && exception.opens_at && exception.closes_at) {
      return [{ open: timeMinutes(exception.opens_at), close: timeMinutes(exception.closes_at) }];
    }
    const weekday = weekdayForDate(date);
    return regularRows
      .filter((row) => Number(row.weekday) === weekday && row.accepts_orders)
      .map((row) => ({ open: timeMinutes(row.opens_at), close: timeMinutes(row.closes_at) }));
  }

  const currentMinute = localNow.hour * 60 + localNow.minute;
  const today = { year: localNow.year, month: localNow.month, day: localNow.day };
  const yesterday = addLocalDays(today, -1);
  const todayIntervals = intervalsForDate(today);
  const yesterdayIntervals = intervalsForDate(yesterday);

  const openToday = todayIntervals.some((interval) => intervalContainsMinute(interval.open, interval.close, currentMinute));
  const openFromYesterday = yesterdayIntervals.some((interval) => interval.open >= interval.close && currentMinute < interval.close);
  const openNow = openToday || openFromYesterday;

  let nextOpenAt: Date | null = null;
  for (let dayOffset = 0; dayOffset <= searchDays; dayOffset += 1) {
    const localDate = addLocalDays(today, dayOffset);
    for (const interval of intervalsForDate(localDate)) {
      const candidate = localDateTimeToUtc({ ...localDate, minuteOfDay: interval.open, timeZone: settings.timezone });
      if (candidate.getTime() > now.getTime() && (!nextOpenAt || candidate < nextOpenAt)) nextOpenAt = candidate;
    }
    if (nextOpenAt) break;
  }

  return {
    openNow,
    nextOpenAt,
    timezone: settings.timezone,
    afterHoursAiEnabled: Boolean(settings.after_hours_ai_enabled),
    allowFutureOrdersWhenClosed: Boolean(settings.allow_future_orders_when_closed),
  };
}

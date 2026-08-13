import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";

export type OrderingService = "all" | "pickup" | "delivery" | "dine_in" | "online" | "phone";
export type AvailabilitySource = "emergency_closure" | "special_service" | "special_general" | "weekly_service" | "weekly_general" | "unconfigured";

export type ResolvedOrderingAvailability = {
  open: boolean;
  orderable: boolean;
  reason: string;
  opensAt: Date | null;
  cutoffAt: Date | null;
  nextAvailableAt: Date | null;
  sourceRule: AvailabilitySource;
  timezone: string;
};

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };
type WindowRow = { service_type: OrderingService; opens_at: string; closes_at: string; ordering_opens_at: string | null; ordering_cutoff_at: string | null; sort_order: number };
type SpecialRow = WindowRow & { status: "closed" | "custom_hours"; label: string };

const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day), hour: Number(value.hour), minute: Number(value.minute), second: Number(value.second), weekday: weekdays[value.weekday] ?? 0 };
}

function dateKey(parts: Pick<LocalParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function minutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** The configured cutoff minute is inclusive through second 59. */
export function isWithinInclusiveWindow(openMinute: number, cutoffMinute: number, currentMinute: number): boolean {
  if (openMinute < cutoffMinute) return currentMinute >= openMinute && currentMinute <= cutoffMinute;
  return currentMinute >= openMinute || currentMinute <= cutoffMinute;
}

function wallTimeUtc(date: Pick<LocalParts, "year" | "month" | "day">, minuteOfDay: number, timeZone: string): Date {
  const desired = Date.UTC(date.year, date.month - 1, date.day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = desired;
  for (let count = 0; count < 4; count += 1) {
    const observed = localParts(new Date(guess), timeZone);
    const delta = desired - Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

function normalizedService(service: string): OrderingService {
  if (service === "delivery" || service === "no_contact_delivery") return "delivery";
  if (service === "dine_in" || service === "bar") return "dine_in";
  if (service === "online" || service === "phone") return service;
  return "pickup";
}

function chooseRows<T extends { service_type: OrderingService }>(rows: T[], service: OrderingService): { rows: T[]; source: AvailabilitySource } {
  const serviceRows = rows.filter((row) => row.service_type === service);
  if (serviceRows.length) return { rows: serviceRows, source: "weekly_service" };
  return { rows: rows.filter((row) => row.service_type === "all"), source: "weekly_general" };
}

export async function resolveOrderingAvailability(input: {
  business: OrderingBusiness;
  serviceType: string;
  at?: Date;
  orderEntryStartedAt?: Date | null;
}): Promise<ResolvedOrderingAvailability> {
  await ensureOrderingTimingSchema();
  const sql = getSql();
  const at = input.at ?? new Date();
  const service = normalizedService(input.serviceType);
  const settingRows = await sql`SELECT timezone FROM ordering_business_ordering_settings WHERE business=${input.business} LIMIT 1` as Array<{ timezone: string }>;
  const timezone = settingRows[0]?.timezone || "America/New_York";
  const local = localParts(at, timezone);
  const businessDate = dateKey(local);

  const closures = await sql`
    SELECT reason, customer_message FROM ordering_emergency_closures
    WHERE business=${input.business} AND service_type IN ('all', ${service})
      AND reopened_at IS NULL AND starts_at <= ${at} AND (ends_at IS NULL OR ends_at >= ${at})
    ORDER BY CASE WHEN service_type=${service} THEN 0 ELSE 1 END, starts_at DESC LIMIT 1
  ` as Array<{ reason: string; customer_message: string }>;
  if (closures[0]) return { open: false, orderable: false, reason: closures[0].customer_message || closures[0].reason || "Ordering is temporarily closed.", opensAt: null, cutoffAt: null, nextAvailableAt: null, sourceRule: "emergency_closure", timezone };

  const specials = await sql`
    SELECT service_type, status, opens_at::text, closes_at::text, ordering_opens_at::text, ordering_cutoff_at::text, label, 0 AS sort_order
    FROM ordering_special_hours WHERE business=${input.business} AND business_date=${businessDate}::date AND service_type IN ('all', ${service})
    ORDER BY CASE WHEN service_type=${service} THEN 0 ELSE 1 END LIMIT 1
  ` as SpecialRow[];
  let selected: WindowRow[];
  let source: AvailabilitySource;
  if (specials[0]) {
    const special = specials[0];
    source = special.service_type === service ? "special_service" : "special_general";
    if (special.status === "closed") return { open: false, orderable: false, reason: special.label || "Closed for this date.", opensAt: null, cutoffAt: null, nextAvailableAt: null, sourceRule: source, timezone };
    selected = [special];
  } else {
    const weekly = await sql`
      SELECT service_type, opens_at::text, closes_at::text, ordering_opens_at::text, ordering_cutoff_at::text, sort_order
      FROM ordering_operating_windows WHERE business=${input.business} AND weekday=${local.weekday} AND active=TRUE AND service_type IN ('all', ${service})
      ORDER BY service_type, sort_order, opens_at
    ` as WindowRow[];
    const choice = chooseRows(weekly, service);
    selected = choice.rows;
    source = choice.source;
  }

  if (!selected.length) {
    const configured = await sql`SELECT service_type FROM ordering_operating_windows WHERE business=${input.business} AND active=TRUE AND service_type IN ('all',${service}) LIMIT 1` as Array<{ service_type: OrderingService }>;
    if (!configured.length) return { open: false, orderable: false, reason: "Ordering hours are not configured for this service and date.", opensAt: null, cutoffAt: null, nextAvailableAt: null, sourceRule: "unconfigured", timezone };
    return { open: false, orderable: false, reason: "This service is closed on the selected date.", opensAt: null, cutoffAt: null, nextAvailableAt: null, sourceRule: configured[0].service_type === service ? "weekly_service" : "weekly_general", timezone };
  }
  const currentMinute = local.hour * 60 + local.minute;
  const entry = input.orderEntryStartedAt ? localParts(input.orderEntryStartedAt, timezone) : null;
  let nextOpen: Date | null = null;
  for (const window of selected) {
    const openMinute = minutes(window.opens_at);
    const closeMinute = minutes(window.closes_at);
    const orderingOpen = minutes(window.ordering_opens_at || window.opens_at);
    const cutoff = minutes(window.ordering_cutoff_at || window.closes_at);
    const open = isWithinInclusiveWindow(openMinute, closeMinute, currentMinute);
    const startedInWindow = entry && dateKey(entry) === businessDate && isWithinInclusiveWindow(orderingOpen, cutoff, entry.hour * 60 + entry.minute);
    const orderable = isWithinInclusiveWindow(orderingOpen, cutoff, currentMinute) || Boolean(startedInWindow);
    const opensAt = wallTimeUtc(local, orderingOpen, timezone);
    const cutoffAt = wallTimeUtc(local, cutoff, timezone);
    if (opensAt > at && (!nextOpen || opensAt < nextOpen)) nextOpen = opensAt;
    if (open || orderable) return { open, orderable, reason: orderable ? "Ordering is available." : "The store is outside ordering hours.", opensAt, cutoffAt, nextAvailableAt: nextOpen, sourceRule: source, timezone };
  }
  return { open: false, orderable: false, reason: "Same-day ordering is closed. Future ordering may still be available.", opensAt: nextOpen, cutoffAt: null, nextAvailableAt: nextOpen, sourceRule: source, timezone };
}

export async function listFutureOrderingSlots(input: { business: OrderingBusiness; serviceType: string; businessDate: string; now?: Date; intervalMinutes?: number }): Promise<Date[]> {
  const interval = Math.max(5, Math.min(60, input.intervalMinutes ?? 15));
  const noon = new Date(`${input.businessDate}T12:00:00Z`);
  const probe = await resolveOrderingAvailability({ business: input.business, serviceType: input.serviceType, at: noon });
  if (probe.sourceRule === "emergency_closure" || probe.sourceRule === "unconfigured") return [];
  const slots: Date[] = [];
  for (let minute = 0; minute < 1440; minute += interval) {
    const candidate = wallTimeUtc({ year: Number(input.businessDate.slice(0, 4)), month: Number(input.businessDate.slice(5, 7)), day: Number(input.businessDate.slice(8, 10)) }, minute, probe.timezone);
    if (candidate <= (input.now ?? new Date())) continue;
    const resolved = await resolveOrderingAvailability({ business: input.business, serviceType: input.serviceType, at: candidate });
    if (resolved.orderable) slots.push(candidate);
  }
  return slots;
}

import { getSql } from "@/lib/db";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";
import { quoteOrderTiming, type OrderTimingMode, type TimingQuoteSettings } from "@/lib/ordering-timing-core";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";
import { resolveOrderingAvailability } from "@/lib/ordering-availability";

type TimingRow = {
  service_type: ServiceType;
  allow_asap: boolean;
  allow_future: boolean;
  normal_min_minutes: number;
  normal_max_minutes: number;
  busy_min_minutes: number;
  busy_max_minutes: number;
  busy_window_minutes: number;
  busy_order_threshold: number | null;
  max_future_days: number;
};

type CountRow = { count: number | string };

export async function getFulfillmentTimingSettings(
  business: OrderingBusiness,
  serviceType: ServiceType,
): Promise<TimingQuoteSettings> {
  await ensureOrderingTimingSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT service_type, allow_asap, allow_future, normal_min_minutes, normal_max_minutes,
           busy_min_minutes, busy_max_minutes, busy_window_minutes, busy_order_threshold,
           max_future_days
    FROM ordering_fulfillment_timing_settings
    WHERE business = ${business} AND service_type = ${serviceType} AND active = TRUE
    LIMIT 1
  `) as TimingRow[];

  const row = rows[0];
  if (!row) {
    // Conservative fallback for fulfillment modes that do not yet have their
    // own settings row. This is primarily useful during development; the owner
    // settings UI will eventually require explicit production configuration.
    return {
      serviceType,
      normalMinMinutes: 30,
      normalMaxMinutes: 30,
      busyMinMinutes: 60,
      busyMaxMinutes: 60,
      busyOrderThreshold: null,
      busyWindowMinutes: 15,
      allowAsap: true,
      allowFuture: true,
      maxFutureDays: 30,
    };
  }

  return {
    serviceType: row.service_type,
    normalMinMinutes: Number(row.normal_min_minutes),
    normalMaxMinutes: Number(row.normal_max_minutes),
    busyMinMinutes: Number(row.busy_min_minutes),
    busyMaxMinutes: Number(row.busy_max_minutes),
    busyOrderThreshold: row.busy_order_threshold == null ? null : Number(row.busy_order_threshold),
    busyWindowMinutes: Number(row.busy_window_minutes),
    allowAsap: Boolean(row.allow_asap),
    allowFuture: Boolean(row.allow_future),
    maxFutureDays: Number(row.max_future_days),
  };
}

async function activeOrdersInBusyWindow(
  business: OrderingBusiness,
  busyWindowMinutes: number,
  now: Date,
): Promise<number> {
  const sql = getSql();
  const windowMinutes = Math.max(1, Math.trunc(busyWindowMinutes));
  const rows = (await sql`
    SELECT COUNT(*)::INTEGER AS count
    FROM ordering_orders
    WHERE business = ${business}
      AND status IN ('confirmed', 'sent_to_kitchen', 'in_progress', 'ready')
      AND created_at >= ${now.toISOString()}::timestamptz - (${windowMinutes} * INTERVAL '1 minute')
      AND created_at <= ${now.toISOString()}::timestamptz
  `) as CountRow[];
  return Number(rows[0]?.count || 0);
}

export async function quoteTimingForOrder(input: {
  business: OrderingBusiness;
  serviceType: ServiceType;
  mode: OrderTimingMode;
  requestedFor?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const settings = await getFulfillmentTimingSettings(input.business, input.serviceType);
  const availability = input.mode === "asap" ? await resolveOrderingAvailability({ business: input.business, serviceType: input.serviceType, at: now, allowPreOpenAsap: true }) : null;
  const preOpenAt = availability?.orderable && !availability.open && availability.opensAt && availability.opensAt > now ? availability.opensAt : null;
  const currentOrdersInBusyWindow = await activeOrdersInBusyWindow(
    input.business,
    settings.busyWindowMinutes,
    now,
  );
  const quote = quoteOrderTiming({
    now: preOpenAt || now,
    mode: input.mode,
    requestedFor: input.requestedFor,
    settings,
    currentOrdersInBusyWindow: preOpenAt ? 0 : currentOrdersInBusyWindow,
  });
  if (preOpenAt && quote.accepted) {
    const opens = new Intl.DateTimeFormat("en-US", { timeZone: availability!.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(preOpenAt);
    quote.customerMessage = `ASAP for the next opening. We open ${opens}; ${quote.customerMessage}`;
  }
  return quote;
}

import type { ServiceType } from "@/lib/ordering-core";

export type OrderTimingMode = "asap" | "future";

export type TimingQuoteSettings = {
  serviceType: ServiceType;
  normalMinMinutes: number;
  normalMaxMinutes: number;
  busyMinMinutes: number;
  busyMaxMinutes: number;
  busyOrderThreshold: number | null;
  busyWindowMinutes: number;
  allowAsap: boolean;
  allowFuture: boolean;
  maxFutureDays: number;
};

export type TimingQuote = {
  mode: OrderTimingMode;
  accepted: boolean;
  isBusy: boolean;
  requestedFor: Date | null;
  promisedFor: Date | null;
  minMinutes: number;
  maxMinutes: number;
  customerMessage: string;
  kitchenLabel: string;
  reason: string;
};

function positiveMinutes(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

export function isDeliveryTimingService(serviceType: ServiceType): boolean {
  return serviceType === "delivery" || serviceType === "no_contact_delivery";
}

export function buildAsapCustomerMessage(input: {
  serviceType: ServiceType;
  minMinutes: number;
  maxMinutes: number;
  busy: boolean;
}): string {
  const min = positiveMinutes(input.minMinutes);
  const max = Math.max(min, positiveMinutes(input.maxMinutes));

  if (input.busy && max >= 60) {
    return "We're saying about an hour right now, but we'll get it to you as fast as we can.";
  }

  if (isDeliveryTimingService(input.serviceType)) {
    if (min === 40 && max === 45) {
      return "We typically say 40 to 45 minutes, but we'll get it to you as fast as we can.";
    }
    if (min === max) {
      return `We're saying about ${max} minutes for delivery, but we'll get it to you as fast as we can.`;
    }
    return `We're saying about ${min} to ${max} minutes for delivery, but we'll get it to you as fast as we can.`;
  }

  if (min === max && max === 30) return "Give us 30 minutes for pickup.";
  if (min === max) return `Give us ${max} minutes for pickup.`;
  return `Pickup is usually about ${min} to ${max} minutes.`;
}

/**
 * Shared timing engine for POS, web, and AI. The caller supplies the current
 * rolling order count from the configured load window. The model never invents
 * a wait time; it reads this quote and says it naturally.
 */
export function quoteOrderTiming(input: {
  now: Date;
  mode: OrderTimingMode;
  requestedFor?: Date | null;
  settings: TimingQuoteSettings;
  currentOrdersInBusyWindow: number;
}): TimingQuote {
  const settings = input.settings;
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs))
    throw new Error("A valid current time is required.");

  if (input.mode === "future") {
    if (!settings.allowFuture) {
      return {
        mode: "future",
        accepted: false,
        isBusy: false,
        requestedFor: input.requestedFor ?? null,
        promisedFor: null,
        minMinutes: 0,
        maxMinutes: 0,
        customerMessage:
          "Future orders are not available for this fulfillment type.",
        kitchenLabel: "",
        reason: "future_orders_disabled",
      };
    }

    const requestedFor = input.requestedFor ?? null;
    if (
      !requestedFor ||
      !Number.isFinite(requestedFor.getTime()) ||
      requestedFor.getTime() <= nowMs
    ) {
      return {
        mode: "future",
        accepted: false,
        isBusy: false,
        requestedFor,
        promisedFor: null,
        minMinutes: 0,
        maxMinutes: 0,
        customerMessage: "Choose a future pickup or delivery time.",
        kitchenLabel: "",
        reason: "future_time_required",
      };
    }

    const maxFutureMs = Math.max(0, settings.maxFutureDays) * 86_400_000;
    if (maxFutureMs > 0 && requestedFor.getTime() - nowMs > maxFutureMs) {
      return {
        mode: "future",
        accepted: false,
        isBusy: false,
        requestedFor,
        promisedFor: null,
        minMinutes: 0,
        maxMinutes: 0,
        customerMessage:
          "That time is farther out than the restaurant currently accepts orders.",
        kitchenLabel: "",
        reason: "future_time_too_far",
      };
    }

    const timingName = isDeliveryTimingService(settings.serviceType)
      ? "DELIVERY"
      : "PICKUP";
    return {
      mode: "future",
      accepted: true,
      isBusy: false,
      requestedFor,
      promisedFor: requestedFor,
      minMinutes: 0,
      maxMinutes: 0,
      customerMessage: `I've got that scheduled for ${formatTime(requestedFor)}.`,
      kitchenLabel: `*** FUTURE ${timingName} ***\nFOR: ${formatTime(requestedFor)}`,
      reason: "future_time_accepted",
    };
  }

  if (!settings.allowAsap) {
    return {
      mode: "asap",
      accepted: false,
      isBusy: false,
      requestedFor: null,
      promisedFor: null,
      minMinutes: 0,
      maxMinutes: 0,
      customerMessage: "ASAP ordering is not available right now.",
      kitchenLabel: "",
      reason: "asap_disabled",
    };
  }

  const busy =
    settings.busyOrderThreshold != null &&
    settings.busyOrderThreshold >= 0 &&
    Math.max(0, Math.trunc(input.currentOrdersInBusyWindow)) >=
      settings.busyOrderThreshold;
  const minMinutes = positiveMinutes(
    busy ? settings.busyMinMinutes : settings.normalMinMinutes,
  );
  const maxMinutes = Math.max(
    minMinutes,
    positiveMinutes(busy ? settings.busyMaxMinutes : settings.normalMaxMinutes),
  );
  const promisedFor = new Date(nowMs + maxMinutes * 60_000);
  const customerMessage = buildAsapCustomerMessage({
    serviceType: settings.serviceType,
    minMinutes,
    maxMinutes,
    busy,
  });
  const timingName = isDeliveryTimingService(settings.serviceType)
    ? "DELIVERY"
    : "PICKUP";
  const range =
    minMinutes === maxMinutes
      ? `${maxMinutes} MIN`
      : `${minMinutes}-${maxMinutes} MIN`;

  return {
    mode: "asap",
    accepted: true,
    isBusy: busy,
    requestedFor: null,
    promisedFor,
    minMinutes,
    maxMinutes,
    customerMessage,
    kitchenLabel: `*** ASAP ${timingName} ***\nQUOTE: ${range}`,
    reason: busy ? "asap_busy_quote" : "asap_normal_quote",
  };
}

export type StoreAvailability = {
  openNow: boolean;
  nextOpenAt: Date | null;
};

const orderingWeekdays: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Shared wall-clock resolver for ordering schedules and fulfillment rules. */
export function orderingLocalDateTime(
  date: Date,
  timeZone = "America/New_York",
) {
  if (!Number.isFinite(date.getTime()))
    throw new Error("A valid fulfillment time is required.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
    weekday: orderingWeekdays[value("weekday")] ?? 0,
  };
}

export function buildAfterHoursAiPrompt(input: StoreAvailability): string {
  if (input.openNow) return "";
  if (!input.nextOpenAt) {
    return "We're closed right now. I can still help you place a future order for the next available ordering time.";
  }
  return `We're closed right now, but I can still take your order for ${formatTime(input.nextOpenAt)} or another available future time.`;
}

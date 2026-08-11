import type { ServiceType } from "@/lib/ordering-core";
import type { OrderTimingMode } from "@/lib/ordering-timing-core";

export type KitchenTicketTimingInput = {
  timingMode: OrderTimingMode;
  serviceType: ServiceType;
  scheduledFor?: Date | null;
  quotedLeadMinMinutes?: number;
  quotedLeadMaxMinutes?: number;
  snapshotLabel?: string;
};

function serviceName(serviceType: ServiceType): string {
  switch (serviceType) {
    case "delivery": return "DELIVERY";
    case "no_contact_delivery": return "NO-CONTACT DELIVERY";
    case "curbside": return "CURBSIDE";
    case "dine_in": return "EAT IN";
    case "bar": return "BAR";
    case "pickup": return "PICKUP";
    default: return "ORDER";
  }
}

function formatScheduled(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

/**
 * Every kitchen ticket gets an explicit timing header. A previously snapshotted
 * label wins so reprints show staff exactly what the order originally said.
 */
export function kitchenTicketTimingHeader(input: KitchenTicketTimingInput): string {
  const snapshot = String(input.snapshotLabel || "").trim();
  if (snapshot) return snapshot;

  const fulfillment = serviceName(input.serviceType);
  if (input.timingMode === "future") {
    if (!input.scheduledFor) return `*** FUTURE ${fulfillment} ***\nTIME REQUIRED`;
    return `*** FUTURE ${fulfillment} ***\nFOR: ${formatScheduled(input.scheduledFor)}`;
  }

  const min = Math.max(0, Math.trunc(input.quotedLeadMinMinutes ?? 0));
  const max = Math.max(min, Math.trunc(input.quotedLeadMaxMinutes ?? min));
  const quote = min === max ? `${max} MIN` : `${min}-${max} MIN`;
  return `*** ASAP ${fulfillment} ***\nQUOTE: ${quote}`;
}

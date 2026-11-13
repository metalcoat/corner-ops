// When a scheduled (future) order reaches the kitchen.
//
// Owner rule (2026-10-24): a future order is held from the kitchen printer,
// the kitchen screen and the online-order chime until its prep time before it
// is due, so a 5 PM order placed at 9 AM doesn't print at 9 AM. Exception: on
// the store's two craziest days, Halloween and Super Bowl Sunday, future
// orders go to the kitchen the moment they're placed (as before), so the
// kitchen can plan the day. Pure date math; tested in tests/ordering-kitchen-release.test.ts.

export const STORE_TIME_ZONE = "America/New_York";
/** Minutes before the due time that a held order is released, at least. */
export const MIN_KITCHEN_LEAD_MINUTES = 25;
/** Extra margin on top of the quoted prep time. */
const RELEASE_MARGIN_MINUTES = 10;

function storeDate(at: Date): { year: number; month: number; day: number; weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: STORE_TIME_ZONE, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday)),
  };
}

/** Super Bowl Sunday: the second Sunday in February (the NFL's calendar since 2022). */
export function isSuperBowlSunday(at: Date): boolean {
  const date = storeDate(at);
  return date.month === 2 && date.weekday === 0 && date.day >= 8 && date.day <= 14;
}

/** Days when future orders print right away instead of being held. */
export function isPrintEverythingDay(at: Date): boolean {
  const date = storeDate(at);
  return (date.month === 10 && date.day === 31) || isSuperBowlSunday(at);
}

/**
 * When the kitchen should get this order, or null for right away (ASAP orders,
 * future orders already inside their prep window, and the exception days).
 */
export function kitchenReleaseAt(input: {
  timingMode: string | null | undefined;
  scheduledFor: Date | null | undefined;
  quotedLeadMaxMinutes?: number | null;
  now?: Date;
}): Date | null {
  if (input.timingMode !== "future" || !input.scheduledFor || !Number.isFinite(input.scheduledFor.getTime())) return null;
  if (isPrintEverythingDay(input.scheduledFor)) return null;
  const lead = Math.max(MIN_KITCHEN_LEAD_MINUTES, Math.trunc(Number(input.quotedLeadMaxMinutes || 0))) + RELEASE_MARGIN_MINUTES;
  const release = new Date(input.scheduledFor.getTime() - lead * 60_000);
  return release.getTime() > (input.now ?? new Date()).getTime() ? release : null;
}

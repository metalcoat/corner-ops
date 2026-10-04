/**
 * Pure minute-of-day helpers for business hours. Windows are stored per
 * business date as [open, close] minutes; close < open means the window runs
 * past midnight. Such an overnight window on date D covers D open..24:00 and
 * D+1 00:00..close, never D 00:00..close. The cutoff/close minute is inclusive
 * (through second 59). open === close is treated as open all day.
 */

export const MINUTES_PER_DAY = 1440;

/** ASAP orders may be accepted this long before ordering opens, not earlier. */
export const PRE_OPEN_ASAP_MINUTES = 60;

/** Part of a window that falls on its own business date. */
export function sameDayWindowCovers(openMinute: number, closeMinute: number, minute: number): boolean {
  if (openMinute === closeMinute) return true;
  if (openMinute < closeMinute) return minute >= openMinute && minute <= closeMinute;
  return minute >= openMinute;
}

/** Part of the previous business date's overnight window that spills past midnight. */
export function previousDaySpilloverCovers(openMinute: number, closeMinute: number, minute: number): boolean {
  return openMinute > closeMinute && minute <= closeMinute;
}

export type MinuteWindow = { open: number; close: number };

/** Open at `minute` today, given today's and yesterday's windows. */
export function windowsCoverMinute(today: MinuteWindow[], yesterday: MinuteWindow[], minute: number): boolean {
  return today.some((window) => sameDayWindowCovers(window.open, window.close, minute))
    || yesterday.some((window) => previousDaySpilloverCovers(window.open, window.close, minute));
}

/** Whether an ASAP order placed now may be accepted ahead of an upcoming opening. */
export function preOpenAsapAllowed(minutesUntilOpening: number, leadMinutes = PRE_OPEN_ASAP_MINUTES): boolean {
  return minutesUntilOpening > 0 && minutesUntilOpening <= leadMinutes;
}

// The store's business day starts at 4 AM Eastern, so late-night orders count
// toward the day they belong to. Pure date math, safe across DST changes.

export const STORE_TIME_ZONE = "America/New_York";
export const BUSINESS_DAY_START_HOUR = 4;

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  ) - date.getTime();
}

/** UTC instant of a wall-clock time in the store's time zone. */
export function storeWallClockToUtc(year: number, month: number, day: number, hour: number, minute = 0, timeZone = STORE_TIME_ZONE): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = wall;
  for (let index = 0; index < 3; index += 1) timestamp = wall - zoneOffsetMs(new Date(timestamp), timeZone);
  return new Date(timestamp);
}

/**
 * Start of the business day for YYYY-MM-DD (4 AM Eastern). With end=true,
 * the start of the following business day (exclusive end of a range).
 */
export function businessDayBoundary(value: string, end = false): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Report dates must use YYYY-MM-DD.");
  const target = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(target.getTime())) throw new Error("Report dates must use YYYY-MM-DD.");
  if (end) target.setUTCDate(target.getUTCDate() + 1);
  return storeWallClockToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), BUSINESS_DAY_START_HOUR);
}

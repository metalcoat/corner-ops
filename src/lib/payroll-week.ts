export const PAYROLL_TIME_ZONE = "America/New_York";
export const PAYROLL_WEEK_START_HOUR = 4;

export function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDateKeyDays(value: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid payroll week.");
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function offsetMilliseconds(date: Date, timeZone = PAYROLL_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return represented - date.getTime();
}

export function newYorkDateTime(dateText: string, hour: number, minute = 0, second = 0): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error("Choose a valid date.");
  const [year, month, day] = dateText.split("-").map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = wallTime;
  for (let index = 0; index < 4; index += 1) {
    timestamp = wallTime - offsetMilliseconds(new Date(timestamp));
  }
  return new Date(timestamp);
}

export function payrollWeekBounds(weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error("Choose a valid payroll week.");
  const start = newYorkDateTime(weekStart, PAYROLL_WEEK_START_HOUR);
  const endKey = addDateKeyDays(weekStart, 7);
  const end = newYorkDateTime(endKey, PAYROLL_WEEK_START_HOUR);
  return { weekStart, start, end };
}

function localParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PAYROLL_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const mapped = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour: Number(mapped.hour),
    weekday: mapped.weekday,
  };
}

export function currentPayrollWeekStart(value = new Date()): string {
  const local = localParts(value);
  const noon = new Date(Date.UTC(local.year, local.month - 1, local.day, 12));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(local.weekday);
  const daysSinceMonday = (Math.max(0, weekday) + 6) % 7;
  noon.setUTCDate(noon.getUTCDate() - daysSinceMonday);
  if (daysSinceMonday === 0 && local.hour < PAYROLL_WEEK_START_HOUR) noon.setUTCDate(noon.getUTCDate() - 7);
  return dateKey(noon);
}

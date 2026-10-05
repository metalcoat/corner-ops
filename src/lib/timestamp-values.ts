/**
 * Helpers for timestamp values read from PostgreSQL. The db layer returns
 * timestamp/timestamptz columns as raw PostgreSQL text such as
 * "2026-10-05 12:34:56.123456+00". Node parses that fine, but Safari does not
 * reliably, so APIs consumed by POS/ordering browsers normalize to ISO 8601.
 */
/** A database timestamp: raw PostgreSQL text, ISO text, a Date, or epoch ms. Anything else reads as empty. */
export type TimestampValue = unknown;

/** Parses a database timestamp (raw text, Date, or epoch ms) into a Date, or null when empty/invalid. */
export function toTimestampDate(value: TimestampValue): Date | null {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === "string" && value.trim()) date = new Date(normalizePostgresTimestampText(value));
  else if (typeof value === "number") date = new Date(value);
  else return null;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Epoch milliseconds for a database timestamp, or NaN when empty/invalid. */
export function toTimestampMs(value: TimestampValue): number {
  return toTimestampDate(value)?.getTime() ?? Number.NaN;
}

/** ISO 8601 ("2026-10-05T12:34:56.123Z") for a database timestamp, or null when empty/invalid. */
export function toIsoTimestamp(value: TimestampValue): string | null {
  return toTimestampDate(value)?.toISOString() ?? null;
}

/** Like toIsoTimestamp, but returns "" for empty/invalid values. */
export function toIsoTimestampOrEmpty(value: TimestampValue): string {
  return toIsoTimestamp(value) ?? "";
}

/**
 * Rewrites PostgreSQL text ("2026-10-05 12:34:56.123456+00") into a form every
 * JS engine parses ("2026-10-05T12:34:56.123456+00:00"). Other strings pass through.
 */
function normalizePostgresTimestampText(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:\s*(Z|[+-]\d{2}(?::?\d{2})?))?$/i.exec(text.trim());
  if (!match) return text;
  const [, day, time, zone] = match;
  let offset = zone ?? "";
  if (/^[+-]\d{2}$/.test(offset)) offset += ":00";
  else if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  // Keep at most millisecond precision; extra fractional digits are not portable.
  const fixedTime = time.replace(/(\.\d{3})\d+$/, "$1");
  return `${day}T${fixedTime}${offset}`;
}

/** Matches PostgreSQL's text output for timestamptz, e.g. "2026-10-05 12:34:56.123456+00". */
const POSTGRES_TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2}){0,2}$/;

/** True when a value is PostgreSQL's raw timestamptz text. */
export function isPostgresTimestampText(value: unknown): value is string {
  return typeof value === "string" && POSTGRES_TIMESTAMPTZ_TEXT.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns a copy of a JSON-ready value with every raw PostgreSQL timestamptz
 * string (in plain objects and arrays, at any depth) rewritten as ISO 8601.
 * Other values, including Date objects and class instances, are left alone.
 * Use only at the boundary of dev-only POS/ordering/customer/driver APIs;
 * production-shaped APIs (workforce, payroll, messages, ...) keep raw text.
 */
export function isoTimestampsDeep<T>(value: T): T {
  if (isPostgresTimestampText(value)) return (toIsoTimestamp(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => isoTimestampsDeep(item)) as T;
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = isoTimestampsDeep(item);
    return copy as T;
  }
  return value;
}

/**
 * Response.json for dev-only POS/ordering/customer/driver APIs: browsers on the
 * POS iPads (Safari) get ISO 8601 timestamps instead of raw PostgreSQL text.
 */
export function isoJson(body: unknown, init?: ResponseInit): Response {
  return Response.json(isoTimestampsDeep(body), init);
}

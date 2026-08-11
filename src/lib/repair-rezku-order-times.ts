import { getSql } from "@/lib/db";

const TIME_ZONE = "America/New_York";
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type TimeParts = {
  hour: number;
  minute: number;
  second: number;
};

type DateTimeParts = DateParts & TimeParts;

function rawObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rawLookup(raw: Record<string, unknown>, candidates: string[]): unknown {
  const fields = new Map(Object.entries(raw).map(([key, value]) => [normalizedKey(key), value]));
  for (const candidate of candidates) {
    const value = fields.get(normalizedKey(candidate));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function offsetMilliseconds(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
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
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return represented - date.getTime();
}

function easternWallTime(parts: DateTimeParts): Date {
  const wallTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let timestamp = wallTime;
  for (let index = 0; index < 3; index += 1) {
    timestamp = wallTime - offsetMilliseconds(new Date(timestamp));
  }
  return new Date(timestamp);
}

function validDateParts(parts: DateParts | null): parts is DateParts {
  if (!parts) return false;
  const test = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return test.getUTCFullYear() === parts.year
    && test.getUTCMonth() === parts.month - 1
    && test.getUTCDate() === parts.day;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function excelParts(serial: number): DateTimeParts | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const date = new Date(EXCEL_EPOCH_UTC + serial * DAY_MS);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function dateParts(value: unknown): DateParts | null {
  const numeric = numericValue(value);
  if (numeric !== null && numeric >= 1) {
    const excel = excelParts(Math.floor(numeric));
    if (excel) return { year: excel.year, month: excel.month, day: excel.day };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  let match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()] || 0;
    const parts = { year: Number(match[3]), month, day: Number(match[2]) };
    return validDateParts(parts) ? parts : null;
  }

  match = text.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (match) {
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    return validDateParts(parts) ? parts : null;
  }

  match = text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (match) {
    const shortYear = Number(match[3]);
    const year = shortYear < 100 ? (shortYear >= 70 ? 1900 + shortYear : 2000 + shortYear) : shortYear;
    const parts = { year, month: Number(match[1]), day: Number(match[2]) };
    return validDateParts(parts) ? parts : null;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate() };
  }
  return null;
}

function clock(hourText: string, minuteText: string, secondText: string | undefined, meridiemText: string | undefined): TimeParts | null {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || 0);
  const meridiem = meridiemText?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function timeParts(value: unknown): TimeParts | null {
  const numeric = numericValue(value);
  if (numeric !== null) {
    const fraction = ((numeric % 1) + 1) % 1;
    const totalSeconds = Math.round(fraction * 24 * 60 * 60) % (24 * 60 * 60);
    return {
      hour: Math.floor(totalSeconds / 3600),
      minute: Math.floor((totalSeconds % 3600) / 60),
      second: totalSeconds % 60,
    };
  }

  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  return match ? clock(match[1], match[2], match[3], match[4]) : null;
}

function fullOpenedAt(value: unknown): Date | null {
  const numeric = numericValue(value);
  if (numeric !== null && numeric >= 1) {
    const parts = excelParts(numeric);
    if (parts && parts.year > 1971) return easternWallTime(parts);
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const instant = new Date(text);
    if (!Number.isNaN(instant.getTime())) return instant;
  }

  const date = dateParts(text);
  const time = timeParts(text);
  if (date && time && /\d{1,2}:\d{2}/.test(text)) return easternWallTime({ ...date, ...time });
  return null;
}

function recoveredOpenedAt(raw: Record<string, unknown>): Date | null {
  const openedValue = rawLookup(raw, ["Opened At", "Open Time", "Order Time", "Created At", "Time"]);
  const full = fullOpenedAt(openedValue);
  if (full) return full;

  const dateValue = rawLookup(raw, ["Date", "Business Date", "Order Date"]);
  const date = dateParts(dateValue);
  const time = timeParts(openedValue);
  if (!date || !time) return null;
  return easternWallTime({ ...date, ...time });
}

export async function repairRezkuOrderTimesForPayroll(start: Date, end: Date) {
  const sql = getSql();
  const searchStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const searchEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const rows = await sql`
    SELECT id, opened_at, raw
    FROM rezku_orders
    WHERE opened_at >= ${searchStart.toISOString()}
      AND opened_at < ${searchEnd.toISOString()}
  ` as unknown as Array<Record<string, unknown>>;

  let repaired = 0;
  let checked = 0;
  let missingRawClock = 0;
  let numericRawClock = 0;
  for (const row of rows) {
    const raw = rawObject(row.raw);
    const rawValue = rawLookup(raw, ["Opened At", "Open Time", "Order Time", "Created At", "Time"]);
    if (numericValue(rawValue) !== null) numericRawClock += 1;
    const recovered = recoveredOpenedAt(raw);
    if (!recovered) {
      missingRawClock += 1;
      continue;
    }

    checked += 1;
    const current = row.opened_at ? new Date(String(row.opened_at)) : null;
    const different = !current
      || Number.isNaN(current.getTime())
      || Math.abs(current.getTime() - recovered.getTime()) >= 60_000;

    if (different) {
      await sql`
        UPDATE rezku_orders
        SET opened_at = ${recovered.toISOString()},
            raw = jsonb_set(raw, '{__payrollOrderTimeRecovered}', 'true'::jsonb, TRUE)
        WHERE id = ${String(row.id)}::uuid
      `;
      repaired += 1;
    }
  }

  return { checked, repaired, missingRawClock, numericRawClock };
}

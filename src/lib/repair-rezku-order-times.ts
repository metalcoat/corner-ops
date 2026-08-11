import { getSql } from "@/lib/db";

const TIME_ZONE = "America/New_York";

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

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

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

function clock(hourText: string, minuteText: string, secondText: string | undefined, meridiemText: string | undefined) {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || 0);
  const meridiem = meridiemText?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function rawOpenedAt(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const instant = new Date(text);
    if (!Number.isNaN(instant.getTime())) return instant;
  }

  let match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (match) {
    const time = clock(match[4], match[5], match[6], match[7]);
    const month = MONTHS[match[1].toLowerCase()] || 0;
    if (time && month) return easternWallTime({
      year: Number(match[3]), month, day: Number(match[2]), ...time,
    });
  }

  match = text.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (match) {
    const time = clock(match[4], match[5], match[6], match[7]);
    if (time) return easternWallTime({
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), ...time,
    });
  }

  match = text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (match) {
    const time = clock(match[4], match[5], match[6], match[7]);
    const shortYear = Number(match[3]);
    const year = shortYear < 100 ? (shortYear >= 70 ? 1900 + shortYear : 2000 + shortYear) : shortYear;
    if (time) return easternWallTime({
      year, month: Number(match[1]), day: Number(match[2]), ...time,
    });
  }

  return null;
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
  for (const row of rows) {
    const raw = rawObject(row.raw);
    const rawValue = rawLookup(raw, ["Opened At", "Open Time", "Order Time", "Created At", "Time"]);
    const recovered = rawOpenedAt(rawValue);
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

  return { checked, repaired, missingRawClock };
}

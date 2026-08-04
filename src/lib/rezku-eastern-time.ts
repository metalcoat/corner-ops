import { createHash } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";

const TIME_ZONE = "America/New_York";
const MIGRATION_KEY = "rezku-wall-times-america-new-york-v1";

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

type RawRow = Record<string, unknown>;

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowLookup(row: RawRow, candidates: string[]): unknown {
  const map = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  for (const candidate of candidates) {
    const value = map.get(normalizeKey(candidate));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function sourceKey(parts: unknown[]): string {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
}

function rawObject(value: unknown): RawRow {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as RawRow;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as RawRow;
    } catch {
      // Leave malformed legacy raw values untouched.
    }
  }
  return {};
}

function fullYear(value: number): number {
  if (value >= 100) return value;
  return value >= 70 ? 1900 + value : 2000 + value;
}

function validDateParts(parts: DateParts): boolean {
  if (parts.year < 1900 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return false;
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return check.getUTCFullYear() === parts.year && check.getUTCMonth() === parts.month - 1 && check.getUTCDate() === parts.day;
}

function dateParts(value: unknown): DateParts | null {
  const text = clean(value, 120);
  if (!text) return null;

  let match = text.match(/(?:^|\D)(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\D|$)/);
  if (match) {
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    return validDateParts(parts) ? parts : null;
  }

  match = text.match(/(?:^|\D)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\D|$)/);
  if (match) {
    const parts = { year: fullYear(Number(match[3])), month: Number(match[1]), day: Number(match[2]) };
    return validDateParts(parts) ? parts : null;
  }

  return null;
}

function timeParts(value: unknown): TimeParts | null {
  const text = clean(value, 120);
  if (!text) return null;
  const match = text.match(/(?:^|\s|T)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s|$)/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = match[4]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
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

function easternDate(parts: DateParts, time: TimeParts): Date {
  const wallTime = Date.UTC(parts.year, parts.month - 1, parts.day, time.hour, time.minute, time.second);
  let timestamp = wallTime;
  for (let index = 0; index < 3; index += 1) {
    timestamp = wallTime - offsetMilliseconds(new Date(timestamp));
  }
  return new Date(timestamp);
}

function explicitInstant(value: unknown): Date | null {
  const text = clean(value, 120);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rezkuDateTime(dateValue: unknown, timeValue: unknown): Date | null {
  const direct = explicitInstant(timeValue);
  if (direct) return direct;

  const fullDate = dateParts(timeValue);
  const fullTime = timeParts(timeValue);
  if (fullDate && fullTime) return easternDate(fullDate, fullTime);

  const date = dateParts(dateValue);
  if (!date) return null;
  return easternDate(date, fullTime || { hour: 0, minute: 0, second: 0 });
}

async function repairShifts(batchId?: string) {
  const sql = getSql();
  const rows = (batchId
    ? await sql`
        SELECT id, batch_id, employee_name, position, reported_hours, raw
        FROM rezku_shifts WHERE batch_id = ${batchId}::uuid
      `
    : await sql`
        SELECT id, batch_id, employee_name, position, reported_hours, raw
        FROM rezku_shifts
      `) as unknown as Array<Record<string, unknown>>;

  let updated = 0;
  let deduplicated = 0;
  for (const row of rows) {
    const raw = rawObject(row.raw);
    const dateValue = rowLookup(raw, ["Date", "Shift Date", "Business Date", "Work Date"]);
    const inValue = rowLookup(raw, ["Clock In", "In", "Start", "Start Time", "Time In"]);
    const outValue = rowLookup(raw, ["Clock Out", "Out", "End", "End Time", "Time Out"]);
    const clockIn = rezkuDateTime(dateValue, inValue);
    let clockOut = rezkuDateTime(dateValue, outValue);
    if (clockIn && clockOut && clockOut.getTime() < clockIn.getTime()) {
      clockOut = new Date(clockOut.getTime() + 24 * 60 * 60 * 1000);
    }
    if (!clockIn && !clockOut) continue;

    const employee = clean(row.employee_name, 120);
    const position = clean(row.position, 80);
    const hours = numeric(row.reported_hours);
    const key = sourceKey(["shift", employee, position, clockIn?.toISOString(), clockOut?.toISOString(), hours]);
    const duplicate = await sql`SELECT id FROM rezku_shifts WHERE source_key = ${key} AND id <> ${String(row.id)}::uuid LIMIT 1` as unknown as Array<{ id: string }>;
    if (duplicate[0]) {
      await sql`DELETE FROM rezku_shifts WHERE id = ${String(row.id)}::uuid`;
      deduplicated += 1;
      continue;
    }
    await sql`
      UPDATE rezku_shifts
      SET source_key = ${key}, clock_in = ${clockIn?.toISOString() || null}, clock_out = ${clockOut?.toISOString() || null}
      WHERE id = ${String(row.id)}::uuid
    `;
    updated += 1;
  }
  return { updated, deduplicated };
}

async function repairOrders(batchId?: string) {
  const sql = getSql();
  const rows = (batchId
    ? await sql`SELECT id, batch_id, order_id, order_type, raw FROM rezku_orders WHERE batch_id = ${batchId}::uuid`
    : await sql`SELECT id, batch_id, order_id, order_type, raw FROM rezku_orders`) as unknown as Array<Record<string, unknown>>;

  let updated = 0;
  let deduplicated = 0;
  for (const row of rows) {
    const raw = rawObject(row.raw);
    const dateValue = rowLookup(raw, ["Date", "Business Date", "Order Date"]);
    const timeValue = rowLookup(raw, ["Opened At", "Open Time", "Order Time", "Created At", "Time"]);
    const openedAt = rezkuDateTime(dateValue, timeValue);
    if (!openedAt) continue;
    const key = sourceKey(["order", clean(row.order_id, 100), openedAt.toISOString(), clean(row.order_type, 100)]);
    const duplicate = await sql`SELECT id FROM rezku_orders WHERE source_key = ${key} AND id <> ${String(row.id)}::uuid LIMIT 1` as unknown as Array<{ id: string }>;
    if (duplicate[0]) {
      await sql`DELETE FROM rezku_orders WHERE id = ${String(row.id)}::uuid`;
      deduplicated += 1;
      continue;
    }
    await sql`UPDATE rezku_orders SET source_key = ${key}, opened_at = ${openedAt.toISOString()} WHERE id = ${String(row.id)}::uuid`;
    updated += 1;
  }
  return { updated, deduplicated };
}

async function repairTransactions(batchId?: string) {
  const sql = getSql();
  const rows = (batchId
    ? await sql`
        SELECT id, batch_id, transaction_id, order_id, tip, raw
        FROM rezku_transactions WHERE batch_id = ${batchId}::uuid
      `
    : await sql`
        SELECT id, batch_id, transaction_id, order_id, tip, raw
        FROM rezku_transactions
      `) as unknown as Array<Record<string, unknown>>;

  let updated = 0;
  let deduplicated = 0;
  for (const row of rows) {
    const raw = rawObject(row.raw);
    const dateValue = rowLookup(raw, ["Date", "Business Date", "Transaction Date"]);
    const timeValue = rowLookup(raw, ["Transaction Time", "Payment Time", "Created At", "Time"]);
    const transactionTime = rezkuDateTime(dateValue, timeValue);
    if (!transactionTime) continue;
    const tip = numeric(row.tip);
    const key = sourceKey([
      "transaction",
      clean(row.transaction_id, 100),
      clean(row.order_id, 100),
      transactionTime.toISOString(),
      tip,
    ]);
    const duplicate = await sql`SELECT id FROM rezku_transactions WHERE source_key = ${key} AND id <> ${String(row.id)}::uuid LIMIT 1` as unknown as Array<{ id: string }>;
    if (duplicate[0]) {
      await sql`DELETE FROM rezku_transactions WHERE id = ${String(row.id)}::uuid`;
      deduplicated += 1;
      continue;
    }
    await sql`
      UPDATE rezku_transactions
      SET source_key = ${key}, transaction_time = ${transactionTime.toISOString()}
      WHERE id = ${String(row.id)}::uuid
    `;
    updated += 1;
  }
  return { updated, deduplicated };
}

export async function repairRezkuBatchTimes(batchId: string) {
  await ensureSchema();
  const [shifts, orders, transactions] = await Promise.all([
    repairShifts(batchId),
    repairOrders(batchId),
    repairTransactions(batchId),
  ]);
  return { shifts, orders, transactions };
}

export async function repairExistingRezkuTimesOnce() {
  await ensureSchema();
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS rezku_data_migrations (
      migration_key TEXT PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  const completed = await sql`SELECT migration_key FROM rezku_data_migrations WHERE migration_key = ${MIGRATION_KEY} LIMIT 1` as unknown as Array<{ migration_key: string }>;
  if (completed[0]) return { migrated: false };

  const [shifts, orders, transactions] = await Promise.all([
    repairShifts(),
    repairOrders(),
    repairTransactions(),
  ]);
  await sql`INSERT INTO rezku_data_migrations (migration_key) VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`;
  return { migrated: true, shifts, orders, transactions };
}

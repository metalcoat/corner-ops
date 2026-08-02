import { createHash, createHmac } from "node:crypto";
import * as XLSX from "xlsx";
import { ensureSchema, getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const TIP_MULTIPLIER = 0.965;
const CUTOFF_HOUR = 15;
const DRIVER_GRACE_MINUTES = 35;

type LocationInput = {
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
};

type EmployeeRow = {
  id: string;
  business: Business;
  name: string;
  position: string;
  role_group: "Driver" | "In-House" | "Ignore";
  counts_for_tips: boolean;
  hourly_rate: string | number;
  tipped_rate: string | number;
  active: boolean;
  created_at: string;
};

type ShiftLike = {
  id: string;
  employeeName: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  countsForTips: boolean;
  clockIn: Date | null;
  clockOut: Date | null;
  reportedHours: number;
};

type TipTransaction = {
  id: string;
  orderId: string;
  time: Date;
  tip: number;
  orderType: string;
};

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowLookup(row: Record<string, unknown>, candidates: string[]): unknown {
  const map = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  for (const candidate of candidates) {
    const value = map.get(normalizeKey(candidate));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, parts.H, parts.M, Math.floor(parts.S)));
  }
  const text = clean(value, 100);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function combineDateAndTime(dateValue: unknown, timeValue: unknown): Date | null {
  const direct = parseDate(timeValue);
  if (direct && direct.getFullYear() > 1971) return direct;

  const date = parseDate(dateValue);
  const timeText = clean(timeValue, 50);
  if (!date || !timeText) return direct;

  const match = timeText.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return direct;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = match[4]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  const result = new Date(date);
  result.setHours(hour, minute, second, 0);
  return result;
}

function roleFromPosition(position: string): "Driver" | "In-House" | "Ignore" {
  const lower = position.toLowerCase();
  if (lower.includes("training") || lower.includes("trainee")) return "Ignore";
  if (lower.includes("driver") || lower.includes("delivery")) return "Driver";
  return "In-House";
}

function pinHash(business: Business, pin: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required.");
  return createHmac("sha256", secret).update(`${business}:${pin}`).digest("hex");
}

function sourceKey(parts: unknown[]): string {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
}

function mapEmployee(row: EmployeeRow) {
  return {
    id: row.id,
    business: row.business,
    name: row.name,
    position: row.position,
    roleGroup: row.role_group,
    countsForTips: row.counts_for_tips,
    hourlyRate: Number(row.hourly_rate),
    tippedRate: Number(row.tipped_rate),
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listEmployees(business: Business) {
  await ensureSchema();
  const rows = await getSql()`
    SELECT id, business, name, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active, created_at
    FROM employees
    WHERE business = ${business}
    ORDER BY active DESC, name
  ` as unknown as EmployeeRow[];
  return rows.map(mapEmployee);
}

export async function createEmployee(input: {
  business: Business;
  name: string;
  pin: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  countsForTips: boolean;
  hourlyRate: number;
  tippedRate: number;
}) {
  await ensureSchema();
  if (!/^\d{5}$/.test(input.pin)) throw new Error("Employee PINs must contain exactly five digits.");
  const name = clean(input.name, 120);
  if (!name) throw new Error("Employee name is required.");

  const id = crypto.randomUUID();
  const rows = await getSql()`
    INSERT INTO employees (
      id, business, name, pin_hash, position, role_group,
      counts_for_tips, hourly_rate, tipped_rate
    )
    VALUES (
      ${id}, ${input.business}, ${name}, ${pinHash(input.business, input.pin)},
      ${clean(input.position, 80) || "Bartender"}, ${input.roleGroup},
      ${input.countsForTips}, ${Math.max(0, input.hourlyRate)}, ${Math.max(0, input.tippedRate)}
    )
    RETURNING id, business, name, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active, created_at
  ` as unknown as EmployeeRow[];
  return mapEmployee(rows[0]);
}

export async function updateEmployee(input: {
  id: string;
  active?: boolean;
  pin?: string;
  name?: string;
  position?: string;
  roleGroup?: "Driver" | "In-House" | "Ignore";
  countsForTips?: boolean;
  hourlyRate?: number;
  tippedRate?: number;
}) {
  await ensureSchema();
  const currentRows = await getSql()`
    SELECT id, business, name, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active, created_at
    FROM employees WHERE id = ${input.id} LIMIT 1
  ` as unknown as EmployeeRow[];
  const current = currentRows[0];
  if (!current) throw new Error("Employee not found.");

  const nextPinHash = input.pin
    ? pinHash(current.business, input.pin)
    : null;
  if (input.pin && !/^\d{5}$/.test(input.pin)) throw new Error("Employee PINs must contain exactly five digits.");

  const rows = await getSql()`
    UPDATE employees SET
      name = ${clean(input.name ?? current.name, 120) || current.name},
      position = ${clean(input.position ?? current.position, 80) || current.position},
      role_group = ${input.roleGroup ?? current.role_group},
      counts_for_tips = ${input.countsForTips ?? current.counts_for_tips},
      hourly_rate = ${Math.max(0, input.hourlyRate ?? Number(current.hourly_rate))},
      tipped_rate = ${Math.max(0, input.tippedRate ?? Number(current.tipped_rate))},
      active = ${input.active ?? current.active},
      pin_hash = COALESCE(${nextPinHash}, pin_hash),
      updated_at = NOW()
    WHERE id = ${input.id}
    RETURNING id, business, name, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active, created_at
  ` as unknown as EmployeeRow[];
  return mapEmployee(rows[0]);
}

export async function punchTiki(pin: string, location: LocationInput) {
  await ensureSchema();
  if (!/^\d{5}$/.test(pin)) throw new Error("Enter your five-digit PIN.");

  const employeeRows = await getSql()`
    SELECT id, business, name, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active, created_at
    FROM employees
    WHERE business = 'Tiki' AND pin_hash = ${pinHash("Tiki", pin)} AND active = TRUE
    LIMIT 1
  ` as unknown as EmployeeRow[];
  const employee = employeeRows[0];
  if (!employee) throw new Error("PIN not recognized.");

  const openRows = await getSql()`
    SELECT id, clock_in
    FROM time_entries
    WHERE employee_id = ${employee.id} AND clock_out IS NULL
    ORDER BY clock_in DESC
    LIMIT 1
  ` as unknown as { id: string; clock_in: string }[];

  const latitude = Number.isFinite(location.latitude) ? location.latitude : null;
  const longitude = Number.isFinite(location.longitude) ? location.longitude : null;
  const accuracy = Number.isFinite(location.accuracy) ? location.accuracy : null;

  if (openRows[0]) {
    const result = await getSql()`
      UPDATE time_entries SET
        clock_out = NOW(),
        clock_out_lat = ${latitude},
        clock_out_lng = ${longitude},
        clock_out_accuracy = ${accuracy},
        status = CASE
          WHEN NOW() - clock_in > INTERVAL '16 hours' THEN 'Needs Review'
          ELSE 'Complete'
        END,
        updated_at = NOW()
      WHERE id = ${openRows[0].id}
      RETURNING id, clock_in, clock_out, status
    ` as unknown as { id: string; clock_in: string; clock_out: string; status: string }[];
    return {
      action: "clocked-out",
      employee: employee.name,
      entry: result[0],
    };
  }

  const id = crypto.randomUUID();
  const result = await getSql()`
    INSERT INTO time_entries (
      id, business, employee_id, employee_name, position, role_group,
      clock_in, clock_in_lat, clock_in_lng, clock_in_accuracy
    )
    VALUES (
      ${id}, 'Tiki', ${employee.id}, ${employee.name}, ${employee.position}, ${employee.role_group},
      NOW(), ${latitude}, ${longitude}, ${accuracy}
    )
    RETURNING id, clock_in, clock_out, status
  ` as unknown as { id: string; clock_in: string; clock_out: string | null; status: string }[];

  return {
    action: "clocked-in",
    employee: employee.name,
    entry: result[0],
  };
}

function getOffsetMilliseconds(date: Date, timeZone: string): number {
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
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return represented - date.getTime();
}

function zonedDateToUtc(dateText: string, hour: number): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  let timestamp = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let index = 0; index < 2; index += 1) {
    timestamp = Date.UTC(year, month - 1, day, hour, 0, 0) - getOffsetMilliseconds(new Date(timestamp), TIME_ZONE);
  }
  return new Date(timestamp);
}

function defaultWeekStart(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localDate = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  const daysSinceMonday = (weekday + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday - 7);
  return localDate.toISOString().slice(0, 10);
}

function weekBounds(weekStart?: string) {
  const startText = /^\d{4}-\d{2}-\d{2}$/.test(weekStart || "") ? weekStart! : defaultWeekStart();
  const start = zonedDateToUtc(startText, 4);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startText, start, end };
}

function durationHours(start: Date | null, end: Date | null, fallback = 0): number {
  if (!start || !end) return fallback;
  return Math.max(0, (end.getTime() - start.getTime()) / 3_600_000);
}

function localHour(date: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
}

function localDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function covers(shift: ShiftLike, time: Date): boolean {
  return Boolean(shift.clockIn && shift.clockOut
    && time.getTime() >= shift.clockIn.getTime()
    && time.getTime() <= shift.clockOut.getTime());
}

function overlapAfterCutoffHours(shift: ShiftLike): number {
  if (!shift.clockIn || !shift.clockOut || shift.roleGroup !== "Driver") return 0;
  const key = localDayKey(shift.clockIn);
  const cutoff = zonedDateToUtc(key, CUTOFF_HOUR);
  const start = Math.max(shift.clockIn.getTime(), cutoff.getTime());
  return Math.max(0, (shift.clockOut.getTime() - start) / 3_600_000);
}

function summarizeShifts(shifts: ShiftLike[]) {
  const byEmployee = new Map<string, {
    employee: string;
    hours: number;
    driverTipHours: number;
    tips: number;
    pickupTips: number;
    deliveryTips: number;
  }>();

  for (const shift of shifts) {
    const row = byEmployee.get(shift.employeeName) || {
      employee: shift.employeeName,
      hours: 0,
      driverTipHours: 0,
      tips: 0,
      pickupTips: 0,
      deliveryTips: 0,
    };
    row.hours += durationHours(shift.clockIn, shift.clockOut, shift.reportedHours);
    row.driverTipHours += overlapAfterCutoffHours(shift);
    byEmployee.set(shift.employeeName, row);
  }

  return byEmployee;
}

function allocateDeliTips(shifts: ShiftLike[], transactions: TipTransaction[], summary: ReturnType<typeof summarizeShifts>) {
  const details: Array<{
    time: string;
    orderId: string;
    orderType: string;
    originalTip: number;
    tipAfterFee: number;
    employee: string;
    splitCount: number;
    rule: string;
  }> = [];

  for (const transaction of transactions) {
    const tipAfterFee = Math.round(transaction.tip * TIP_MULTIPLIER * 100) / 100;
    if (tipAfterFee === 0) continue;

    const isDelivery = transaction.orderType.toLowerCase().includes("deliver");
    let eligible: ShiftLike[] = [];
    let rule = "";

    if (localHour(transaction.time) < CUTOFF_HOUR) {
      eligible = shifts.filter((shift) => shift.countsForTips && shift.roleGroup !== "Ignore" && covers(shift, transaction.time));
      rule = "Before 3 PM: all tip-eligible employees clocked in";
    } else if (isDelivery) {
      eligible = shifts.filter((shift) => shift.countsForTips && shift.roleGroup === "Driver" && covers(shift, transaction.time));
      if (eligible.length === 0) {
        const graceEnd = transaction.time.getTime() + DRIVER_GRACE_MINUTES * 60_000;
        eligible = shifts.filter((shift) => shift.countsForTips
          && shift.roleGroup === "Driver"
          && shift.clockIn
          && shift.clockIn.getTime() > transaction.time.getTime()
          && shift.clockIn.getTime() <= graceEnd);
        rule = "Delivery: driver arrived within 35-minute grace window";
      } else {
        rule = "After 3 PM delivery: driver clocked in";
      }

      if (eligible.length === 0) {
        eligible = shifts.filter((shift) => shift.countsForTips && shift.roleGroup !== "Ignore" && covers(shift, transaction.time));
        rule = "Delivery fallback: split among other employees clocked in";
      }
    } else {
      eligible = shifts.filter((shift) => shift.countsForTips && shift.roleGroup === "In-House" && covers(shift, transaction.time));
      rule = "After 3 PM pickup/takeout: in-house employees clocked in";
    }

    if (eligible.length === 0) {
      const sameDay = shifts.filter((shift) => shift.countsForTips && shift.clockOut && localDayKey(shift.clockOut) === localDayKey(transaction.time));
      const lastClockOut = Math.max(...sameDay.map((shift) => shift.clockOut?.getTime() || 0), 0);
      eligible = sameDay.filter((shift) => shift.clockOut?.getTime() === lastClockOut);
      rule = "After-close fallback: employees who signed out last";
    }

    if (eligible.length === 0) continue;
    const split = Math.round((tipAfterFee / eligible.length) * 100) / 100;

    for (const shift of eligible) {
      const row = summary.get(shift.employeeName) || {
        employee: shift.employeeName,
        hours: 0,
        driverTipHours: 0,
        tips: 0,
        pickupTips: 0,
        deliveryTips: 0,
      };
      row.tips += split;
      if (isDelivery) row.deliveryTips += split;
      else row.pickupTips += split;
      summary.set(shift.employeeName, row);
      details.push({
        time: transaction.time.toISOString(),
        orderId: transaction.orderId,
        orderType: transaction.orderType,
        originalTip: transaction.tip,
        tipAfterFee,
        employee: shift.employeeName,
        splitCount: eligible.length,
        rule,
      });
    }
  }

  return details;
}

export async function payrollSummary(business: Business, weekStart?: string) {
  await ensureSchema();
  const bounds = weekBounds(weekStart);

  if (business === "Tiki") {
    const rows = await getSql()`
      SELECT id, employee_name, position, role_group, clock_in, clock_out
      FROM time_entries
      WHERE business = 'Tiki'
        AND clock_in >= ${bounds.start.toISOString()}
        AND clock_in < ${bounds.end.toISOString()}
      ORDER BY clock_in
    ` as unknown as Array<{
      id: string;
      employee_name: string;
      position: string;
      role_group: "Driver" | "In-House" | "Ignore";
      clock_in: string;
      clock_out: string | null;
    }>;

    const shifts: ShiftLike[] = rows.map((row) => ({
      id: row.id,
      employeeName: row.employee_name,
      position: row.position,
      roleGroup: row.role_group,
      countsForTips: row.role_group !== "Ignore",
      clockIn: parseDate(row.clock_in),
      clockOut: parseDate(row.clock_out),
      reportedHours: 0,
    }));
    const summary = summarizeShifts(shifts);
    return {
      business,
      source: "Corner Ops time clock",
      weekStart: bounds.startText,
      weekEnd: new Date(bounds.end.getTime() - 1).toISOString(),
      rows: Array.from(summary.values()).map((row) => ({
        ...row,
        regularHours: Math.min(40, row.hours),
        overtimeHours: Math.max(0, row.hours - 40),
      })),
      tipDetails: [],
    };
  }

  const shiftRows = await getSql()`
    SELECT id, employee_name, position, role_group, clock_in, clock_out, reported_hours
    FROM rezku_shifts
    WHERE clock_in >= ${bounds.start.toISOString()}
      AND clock_in < ${bounds.end.toISOString()}
    ORDER BY clock_in
  ` as unknown as Array<{
    id: string;
    employee_name: string;
    position: string;
    role_group: "Driver" | "In-House" | "Ignore";
    clock_in: string | null;
    clock_out: string | null;
    reported_hours: string | number;
  }>;

  const orderRows = await getSql()`
    SELECT order_id, opened_at, order_type
    FROM rezku_orders
    WHERE opened_at >= ${bounds.start.toISOString()}
      AND opened_at < ${bounds.end.toISOString()}
  ` as unknown as Array<{ order_id: string; opened_at: string | null; order_type: string }>;
  const orders = new Map(orderRows.map((row) => [row.order_id, row]));

  const transactionRows = await getSql()`
    SELECT id, order_id, transaction_time, tip
    FROM rezku_transactions
    WHERE transaction_time >= ${bounds.start.toISOString()}
      AND transaction_time < ${bounds.end.toISOString()}
      AND tip <> 0
    ORDER BY transaction_time
  ` as unknown as Array<{ id: string; order_id: string; transaction_time: string; tip: string | number }>;

  const shifts: ShiftLike[] = shiftRows.map((row) => ({
    id: row.id,
    employeeName: row.employee_name,
    position: row.position,
    roleGroup: row.role_group,
    countsForTips: row.role_group !== "Ignore",
    clockIn: parseDate(row.clock_in),
    clockOut: parseDate(row.clock_out),
    reportedHours: numeric(row.reported_hours),
  }));

  const transactions: TipTransaction[] = transactionRows
    .map((row) => {
      const time = parseDate(row.transaction_time);
      const order = orders.get(row.order_id);
      return time ? {
        id: row.id,
        orderId: row.order_id,
        time,
        tip: numeric(row.tip),
        orderType: order?.order_type || "",
      } : null;
    })
    .filter((row): row is TipTransaction => Boolean(row));

  const summary = summarizeShifts(shifts);
  const tipDetails = allocateDeliTips(shifts, transactions, summary);
  return {
    business,
    source: "Rezku daily email reports",
    weekStart: bounds.startText,
    weekEnd: new Date(bounds.end.getTime() - 1).toISOString(),
    rows: Array.from(summary.values()).map((row) => ({
      ...row,
      regularHours: Math.min(40, row.hours),
      overtimeHours: Math.max(0, row.hours - 40),
    })),
    tipDetails: tipDetails.slice(-250).reverse(),
  };
}

function reportType(filename: string, requested?: string): "shifts" | "orders" | "transactions" {
  if (requested === "shifts" || requested === "orders" || requested === "transactions") return requested;
  const lower = filename.toLowerCase();
  if (lower.includes("labor") || lower.includes("shift") || lower.includes("attestation") || lower.includes("timecard")) return "shifts";
  if (lower.includes("transaction") || lower.includes("payment")) return "transactions";
  if (lower.includes("order")) return "orders";
  throw new Error("Could not identify the Rezku report type from the filename.");
}

function workbookRows(workbook: XLSX.WorkBook, kind: "shifts" | "orders" | "transactions") {
  const names = kind === "shifts"
    ? workbook.SheetNames
    : [workbook.SheetNames.find((name) => name.toLowerCase() === "main") || workbook.SheetNames[0]];
  return names.flatMap((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
      dateNF: "yyyy-mm-dd hh:mm:ss",
    }).map((row) => ({ ...row, __sheet: sheetName }));
  });
}

export async function importRezkuReport(fileName: string, bytes: ArrayBuffer, requestedType: string | undefined, actor: string) {
  await ensureSchema();
  const kind = reportType(fileName, requestedType);
  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  const rows = workbookRows(workbook, kind);
  const batchId = crypto.randomUUID();

  await getSql()`
    INSERT INTO rezku_import_batches (id, report_type, file_name, row_count, imported_by)
    VALUES (${batchId}, ${kind}, ${clean(fileName, 255)}, ${rows.length}, ${actor})
  `;

  let imported = 0;
  for (const row of rows) {
    if (kind === "shifts") {
      const employee = clean(rowLookup(row, ["Employee", "Employee Name", "Team Member", "Name"]), 120)
        || clean(row.__sheet, 120);
      if (!employee || /^main$/i.test(employee)) continue;
      const position = clean(rowLookup(row, ["Position", "Job", "Role", "Job Title"]), 80);
      const dateValue = rowLookup(row, ["Date", "Shift Date", "Business Date", "Work Date"]);
      const clockIn = combineDateAndTime(dateValue, rowLookup(row, ["Clock In", "In", "Start", "Start Time", "Time In"]));
      let clockOut = combineDateAndTime(dateValue, rowLookup(row, ["Clock Out", "Out", "End", "End Time", "Time Out"]));
      if (clockIn && clockOut && clockOut.getTime() < clockIn.getTime()) {
        clockOut = new Date(clockOut.getTime() + 24 * 60 * 60 * 1000);
      }
      const hours = numeric(rowLookup(row, ["Regular Hours", "Total Hours", "Hours", "Reg Hours"]))
        + numeric(rowLookup(row, ["Overtime Hours", "OT Hours", "Overtime"]));
      const key = sourceKey(["shift", employee, position, clockIn?.toISOString(), clockOut?.toISOString(), hours]);
      const result = await getSql()`
        INSERT INTO rezku_shifts (
          id, source_key, batch_id, employee_name, position, role_group,
          clock_in, clock_out, reported_hours, raw
        )
        VALUES (
          ${crypto.randomUUID()}, ${key}, ${batchId}, ${employee}, ${position},
          ${roleFromPosition(position)}, ${clockIn?.toISOString() || null},
          ${clockOut?.toISOString() || null}, ${hours}, ${JSON.stringify(row)}::jsonb
        )
        ON CONFLICT (source_key) DO NOTHING
        RETURNING id
      ` as unknown as { id: string }[];
      if (result.length) imported += 1;
    }

    if (kind === "orders") {
      const orderId = clean(rowLookup(row, ["Order ID", "Order Number", "Order #", "ID"]), 100);
      if (!orderId) continue;
      const dateValue = rowLookup(row, ["Date", "Business Date", "Order Date"]);
      const openedAt = combineDateAndTime(dateValue, rowLookup(row, ["Opened At", "Open Time", "Order Time", "Created At", "Time"]));
      const orderType = clean(rowLookup(row, ["Order Type", "Dining Option", "Service Type", "Type"]), 100);
      const key = sourceKey(["order", orderId, openedAt?.toISOString(), orderType]);
      const result = await getSql()`
        INSERT INTO rezku_orders (id, source_key, batch_id, order_id, opened_at, order_type, raw)
        VALUES (
          ${crypto.randomUUID()}, ${key}, ${batchId}, ${orderId},
          ${openedAt?.toISOString() || null}, ${orderType}, ${JSON.stringify(row)}::jsonb
        )
        ON CONFLICT (source_key) DO NOTHING
        RETURNING id
      ` as unknown as { id: string }[];
      if (result.length) imported += 1;
    }

    if (kind === "transactions") {
      const orderId = clean(rowLookup(row, ["Order ID", "Order Number", "Order #"]), 100);
      const transactionId = clean(rowLookup(row, ["Transaction ID", "Payment ID", "ID"]), 100);
      const dateValue = rowLookup(row, ["Date", "Business Date", "Transaction Date"]);
      const transactionTime = combineDateAndTime(dateValue, rowLookup(row, ["Transaction Time", "Payment Time", "Created At", "Time"]));
      const tip = numeric(rowLookup(row, ["Tip", "Tip Amount", "Gratuity"]));
      if (!orderId && !transactionId && !transactionTime) continue;
      const key = sourceKey(["transaction", transactionId, orderId, transactionTime?.toISOString(), tip]);
      const result = await getSql()`
        INSERT INTO rezku_transactions (
          id, source_key, batch_id, transaction_id, order_id, transaction_time, tip, raw
        )
        VALUES (
          ${crypto.randomUUID()}, ${key}, ${batchId}, ${transactionId}, ${orderId},
          ${transactionTime?.toISOString() || null}, ${tip}, ${JSON.stringify(row)}::jsonb
        )
        ON CONFLICT (source_key) DO NOTHING
        RETURNING id
      ` as unknown as { id: string }[];
      if (result.length) imported += 1;
    }
  }

  return { batchId, reportType: kind, rowsRead: rows.length, imported };
}

export async function listRezkuImports() {
  await ensureSchema();
  const rows = await getSql()`
    SELECT id, report_type, file_name, row_count, imported_by, imported_at
    FROM rezku_import_batches
    ORDER BY imported_at DESC
    LIMIT 40
  ` as unknown as Array<{
    id: string;
    report_type: string;
    file_name: string;
    row_count: number;
    imported_by: string;
    imported_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    reportType: row.report_type,
    fileName: row.file_name,
    rowCount: row.row_count,
    importedBy: row.imported_by,
    importedAt: row.imported_at,
  }));
}

export async function listRecentTimeEntries(business: Business) {
  await ensureSchema();
  const rows = await getSql()`
    SELECT id, employee_id, employee_name, position, role_group, clock_in, clock_out,
      clock_in_lat, clock_in_lng, clock_in_accuracy,
      clock_out_lat, clock_out_lng, clock_out_accuracy,
      source, status, notes
    FROM time_entries
    WHERE business = ${business}
    ORDER BY clock_in DESC
    LIMIT 150
  ` as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    position: row.position,
    roleGroup: row.role_group,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    clockInLocation: {
      latitude: row.clock_in_lat === null ? null : Number(row.clock_in_lat),
      longitude: row.clock_in_lng === null ? null : Number(row.clock_in_lng),
      accuracy: row.clock_in_accuracy === null ? null : Number(row.clock_in_accuracy),
    },
    clockOutLocation: {
      latitude: row.clock_out_lat === null ? null : Number(row.clock_out_lat),
      longitude: row.clock_out_lng === null ? null : Number(row.clock_out_lng),
      accuracy: row.clock_out_accuracy === null ? null : Number(row.clock_out_accuracy),
    },
    source: row.source,
    status: row.status,
    notes: row.notes,
  }));
}

export async function accountingSnapshot(business: Business) {
  await ensureSchema();
  const accounts = await getSql()`
    SELECT id, code, name, account_type, active
    FROM accounting_accounts
    WHERE business = ${business}
    ORDER BY code
  ` as unknown as Array<{ id: string; code: string; name: string; account_type: string; active: boolean }>;

  const balances = await getSql()`
    SELECT a.id, a.code, a.name, a.account_type,
      COALESCE(SUM(l.debit), 0) AS debits,
      COALESCE(SUM(l.credit), 0) AS credits
    FROM accounting_accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    WHERE a.business = ${business}
    GROUP BY a.id, a.code, a.name, a.account_type
    ORDER BY a.code
  ` as unknown as Array<{
    id: string;
    code: string;
    name: string;
    account_type: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
    debits: string | number;
    credits: string | number;
  }>;

  const recent = await getSql()`
    SELECT e.id, e.entry_date, e.description, e.source, e.reference, e.created_by, e.created_at,
      COALESCE(SUM(l.debit), 0) AS amount
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.business = ${business}
    GROUP BY e.id
    ORDER BY e.entry_date DESC, e.created_at DESC
    LIMIT 50
  ` as unknown as Array<Record<string, unknown>>;

  let revenue = 0;
  let expenses = 0;
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  for (const row of balances) {
    const debits = numeric(row.debits);
    const credits = numeric(row.credits);
    if (row.account_type === "Revenue") revenue += credits - debits;
    if (row.account_type === "Expense") expenses += debits - credits;
    if (row.account_type === "Asset") assets += debits - credits;
    if (row.account_type === "Liability") liabilities += credits - debits;
    if (row.account_type === "Equity") equity += credits - debits;
  }

  return {
    business,
    summary: { revenue, expenses, profit: revenue - expenses, assets, liabilities, equity },
    accounts: accounts.map((row) => ({ ...row, accountType: row.account_type })),
    balances: balances.map((row) => ({
      ...row,
      accountType: row.account_type,
      balance: row.account_type === "Asset" || row.account_type === "Expense"
        ? numeric(row.debits) - numeric(row.credits)
        : numeric(row.credits) - numeric(row.debits),
    })),
    recent: recent.map((row) => ({
      id: row.id,
      entryDate: row.entry_date,
      description: row.description,
      source: row.source,
      reference: row.reference,
      createdBy: row.created_by,
      createdAt: row.created_at,
      amount: numeric(row.amount),
    })),
  };
}

export async function createSimpleJournalEntry(input: {
  business: Business;
  entryDate: string;
  description: string;
  reference: string;
  kind: "Revenue" | "Expense";
  accountCode: string;
  amount: number;
  actor: string;
}) {
  await ensureSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate)) throw new Error("A valid entry date is required.");
  const amount = Math.round(Math.abs(input.amount) * 100) / 100;
  if (amount <= 0) throw new Error("Amount must be greater than zero.");

  const accountRows = await getSql()`
    SELECT id, code, account_type
    FROM accounting_accounts
    WHERE business = ${input.business} AND code IN ('1000', ${input.accountCode})
  ` as unknown as Array<{ id: string; code: string; account_type: string }>;
  const cash = accountRows.find((row) => row.code === "1000");
  const category = accountRows.find((row) => row.code === input.accountCode);
  if (!cash || !category) throw new Error("The selected account could not be found.");
  if (category.account_type !== input.kind) throw new Error(`Select a ${input.kind.toLowerCase()} account.`);

  const entryId = crypto.randomUUID();
  await getSql()`
    INSERT INTO journal_entries (id, business, entry_date, description, source, reference, created_by)
    VALUES (
      ${entryId}, ${input.business}, ${input.entryDate}, ${clean(input.description, 240)},
      'Manual', ${clean(input.reference, 100)}, ${input.actor}
    )
  `;

  if (input.kind === "Revenue") {
    await getSql()`
      INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
      VALUES
        (${crypto.randomUUID()}, ${entryId}, ${cash.id}, ${amount}, 0),
        (${crypto.randomUUID()}, ${entryId}, ${category.id}, 0, ${amount})
    `;
  } else {
    await getSql()`
      INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
      VALUES
        (${crypto.randomUUID()}, ${entryId}, ${category.id}, ${amount}, 0),
        (${crypto.randomUUID()}, ${entryId}, ${cash.id}, 0, ${amount})
    `;
  }

  return { id: entryId };
}

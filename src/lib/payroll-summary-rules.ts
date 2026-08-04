import { getSql } from "@/lib/db";
import { payrollSummary as legacyPayrollSummary } from "@/lib/operations";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const TIP_MULTIPLIER = 0.965;
const CUTOFF_HOUR = 15;
const DRIVER_GRACE_MINUTES = 35;

type RoleGroup = "Driver" | "In-House" | "Ignore";

type Shift = {
  id: string;
  employeeName: string;
  position: string;
  roleGroup: RoleGroup;
  countsForTips: boolean;
  clockIn: Date | null;
  clockOut: Date | null;
  reportedHours: number;
};

type Transaction = {
  id: string;
  orderId: string;
  time: Date;
  tip: number;
  orderType: string;
};

type SummaryRow = {
  employee: string;
  hours: number;
  driverTipHours: number;
  tips: number;
  pickupTips: number;
  deliveryTips: number;
};

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function canonicalEmployeeName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (/^can$/i.test(name)) return "Ken";
  return name;
}

function dateValue(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getOffsetMilliseconds(date: Date): number {
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
  return Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  ) - date.getTime();
}

function zonedDateToUtc(dateText: string, hour: number): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, 0, 0);
  let timestamp = wallTime;
  for (let index = 0; index < 3; index += 1) {
    timestamp = wallTime - getOffsetMilliseconds(new Date(timestamp));
  }
  return new Date(timestamp);
}

function weekBounds(weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error("Choose a valid payroll week.");
  const start = zonedDateToUtc(weekStart, 4);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
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

function isDriver(shift: Shift): boolean {
  return shift.roleGroup === "Driver" || /\b(driver|delivery|deliveries)\b/i.test(shift.position);
}

function isEligible(shift: Shift): boolean {
  return shift.countsForTips && shift.roleGroup !== "Ignore" && !/^cover$/i.test(shift.employeeName);
}

function covers(shift: Shift, time: Date): boolean {
  return Boolean(shift.clockIn && shift.clockOut
    && time.getTime() >= shift.clockIn.getTime()
    && time.getTime() <= shift.clockOut.getTime());
}

function durationHours(shift: Shift): number {
  if (shift.clockIn && shift.clockOut) {
    return Math.max(0, (shift.clockOut.getTime() - shift.clockIn.getTime()) / 3_600_000);
  }
  return Math.max(0, shift.reportedHours);
}

function driverHoursAfterThree(shift: Shift): number {
  if (!isDriver(shift) || !shift.clockIn || !shift.clockOut) return 0;
  const cutoff = zonedDateToUtc(localDayKey(shift.clockIn), CUTOFF_HOUR);
  return Math.max(0, (shift.clockOut.getTime() - Math.max(shift.clockIn.getTime(), cutoff.getTime())) / 3_600_000);
}

function uniqueEmployees(shifts: Shift[]): Shift[] {
  const byEmployee = new Map<string, Shift>();
  for (const shift of shifts) {
    const key = canonicalEmployeeName(shift.employeeName).toLowerCase();
    if (!byEmployee.has(key)) byEmployee.set(key, shift);
  }
  return [...byEmployee.values()].sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

function lastSignedOut(shifts: Shift[], transaction: Transaction, predicate: (shift: Shift) => boolean): Shift[] {
  const sameDay = shifts.filter((shift) => isEligible(shift)
    && predicate(shift)
    && shift.clockOut
    && localDayKey(shift.clockOut) === localDayKey(transaction.time));
  const alreadyOut = sameDay.filter((shift) => (shift.clockOut?.getTime() || 0) <= transaction.time.getTime());
  const candidates = alreadyOut.length ? alreadyOut : sameDay;
  const latest = Math.max(...candidates.map((shift) => shift.clockOut?.getTime() || 0), 0);
  return uniqueEmployees(candidates.filter((shift) => shift.clockOut?.getTime() === latest));
}

function splitCents(totalCents: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.trunc(totalCents / count);
  const remainder = totalCents - base * count;
  const direction = remainder < 0 ? -1 : 1;
  return Array.from({ length: count }, (_, index) => base + (index < Math.abs(remainder) ? direction : 0));
}

function rowFor(summary: Map<string, SummaryRow>, employeeName: string): SummaryRow {
  const employee = canonicalEmployeeName(employeeName);
  const row = summary.get(employee) || {
    employee,
    hours: 0,
    driverTipHours: 0,
    tips: 0,
    pickupTips: 0,
    deliveryTips: 0,
  };
  summary.set(employee, row);
  return row;
}

function summarizeShifts(shifts: Shift[]) {
  const summary = new Map<string, SummaryRow>();
  for (const shift of shifts) {
    if (!shift.employeeName || /^cover$/i.test(shift.employeeName)) continue;
    const row = rowFor(summary, shift.employeeName);
    row.hours += durationHours(shift);
    row.driverTipHours += driverHoursAfterThree(shift);
  }
  return summary;
}

function allocateTips(shifts: Shift[], transactions: Transaction[], summary: Map<string, SummaryRow>) {
  const details: Array<Record<string, unknown>> = [];

  for (const transaction of transactions) {
    const totalCents = Math.round(transaction.tip * TIP_MULTIPLIER * 100);
    if (!totalCents) continue;

    const beforeThree = localHour(transaction.time) < CUTOFF_HOUR;
    const delivery = /deliver/i.test(transaction.orderType);
    let eligible: Shift[] = [];
    let rule = "";

    if (beforeThree) {
      eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && covers(shift, transaction.time)));
      rule = "Before 3 PM: equally split among all tip-eligible employees clocked in";
    } else if (delivery) {
      eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && isDriver(shift) && covers(shift, transaction.time)));
      if (eligible.length) {
        rule = "After 3 PM delivery: assigned to driver clocked in";
      } else {
        const graceEnd = transaction.time.getTime() + DRIVER_GRACE_MINUTES * 60_000;
        eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift)
          && isDriver(shift)
          && shift.clockIn
          && shift.clockIn.getTime() > transaction.time.getTime()
          && shift.clockIn.getTime() <= graceEnd));
        if (eligible.length) rule = "After 3 PM delivery: driver arrived within 35 minutes";
      }
      if (!eligible.length) {
        eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && !isDriver(shift) && covers(shift, transaction.time)));
        rule = "After 3 PM delivery fallback: equally split among non-driver employees clocked in";
      }
    } else {
      eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && !isDriver(shift) && covers(shift, transaction.time)));
      rule = "After 3 PM takeout: equally split among non-driver employees clocked in";
    }

    if (!eligible.length) {
      const predicate = beforeThree
        ? (_shift: Shift) => true
        : delivery
          ? (shift: Shift) => !isDriver(shift)
          : (shift: Shift) => !isDriver(shift);
      eligible = lastSignedOut(shifts, transaction, predicate);
      rule = beforeThree
        ? "Before 3 PM after-close fallback: equally split among employees who signed out last"
        : delivery
          ? "After 3 PM delivery fallback: equally split among non-drivers who signed out last"
          : "After 3 PM takeout fallback: equally split among non-drivers who signed out last";
    }

    if (!eligible.length) continue;
    const allocations = splitCents(totalCents, eligible.length);
    eligible.forEach((shift, index) => {
      const amount = allocations[index] / 100;
      const row = rowFor(summary, shift.employeeName);
      row.tips = Math.round((row.tips + amount) * 100) / 100;
      if (delivery) row.deliveryTips = Math.round((row.deliveryTips + amount) * 100) / 100;
      else row.pickupTips = Math.round((row.pickupTips + amount) * 100) / 100;
      details.push({
        time: transaction.time.toISOString(),
        orderId: transaction.orderId,
        orderType: transaction.orderType,
        originalTip: transaction.tip,
        tipAfterFee: totalCents / 100,
        allocatedTip: amount,
        employee: canonicalEmployeeName(shift.employeeName),
        splitCount: eligible.length,
        rule,
      });
    });
  }

  return details;
}

export async function payrollSummary(business: Business, weekStart: string) {
  if (business === "Tiki") return legacyPayrollSummary(business, weekStart);

  const bounds = weekBounds(weekStart);
  const shiftRows = await getSql()`
    SELECT id, employee_name, position, role_group, clock_in, clock_out, reported_hours
    FROM rezku_shifts
    WHERE clock_in >= ${bounds.start.toISOString()}
      AND clock_in < ${bounds.end.toISOString()}
    ORDER BY clock_in
  ` as unknown as Array<Record<string, unknown>>;
  const orderRows = await getSql()`
    SELECT order_id, opened_at, order_type
    FROM rezku_orders
    WHERE opened_at >= ${bounds.start.toISOString()}
      AND opened_at < ${bounds.end.toISOString()}
  ` as unknown as Array<Record<string, unknown>>;
  const transactionRows = await getSql()`
    SELECT id, order_id, transaction_time, tip
    FROM rezku_transactions
    WHERE transaction_time >= ${bounds.start.toISOString()}
      AND transaction_time < ${bounds.end.toISOString()}
      AND tip <> 0
    ORDER BY transaction_time
  ` as unknown as Array<Record<string, unknown>>;

  const shifts: Shift[] = shiftRows
    .map((row) => ({
      id: String(row.id),
      employeeName: canonicalEmployeeName(row.employee_name),
      position: String(row.position || ""),
      roleGroup: row.role_group as RoleGroup,
      countsForTips: row.role_group !== "Ignore",
      clockIn: dateValue(row.clock_in),
      clockOut: dateValue(row.clock_out),
      reportedHours: numberValue(row.reported_hours),
    }))
    .filter((shift) => shift.employeeName && !/^cover$/i.test(shift.employeeName));

  const orders = new Map(orderRows.map((row) => [String(row.order_id || ""), String(row.order_type || "")]));
  const transactions: Transaction[] = transactionRows
    .map((row) => {
      const time = dateValue(row.transaction_time);
      if (!time) return null;
      return {
        id: String(row.id),
        orderId: String(row.order_id || ""),
        time,
        tip: numberValue(row.tip),
        orderType: orders.get(String(row.order_id || "")) || "",
      };
    })
    .filter((transaction): transaction is Transaction => Boolean(transaction));

  const summary = summarizeShifts(shifts);
  const tipDetails = allocateTips(shifts, transactions, summary);
  const rows = [...summary.values()]
    .map((row) => {
      const hours = Math.round(row.hours * 100) / 100;
      const overtimeHours = Math.round(Math.max(0, hours - 40) * 100) / 100;
      const straightTimeHours = Math.round(Math.max(0, hours - overtimeHours) * 100) / 100;
      const driverTipHours = Math.round(Math.min(row.driverTipHours, straightTimeHours) * 100) / 100;
      const regularHours = Math.round(Math.max(0, straightTimeHours - driverTipHours) * 100) / 100;
      return {
        ...row,
        hours,
        driverTipHours,
        regularHours,
        overtimeHours,
        tips: Math.round(row.tips * 100) / 100,
        pickupTips: Math.round(row.pickupTips * 100) / 100,
        deliveryTips: Math.round(row.deliveryTips * 100) / 100,
      };
    })
    .sort((left, right) => left.employee.localeCompare(right.employee));

  return {
    business,
    source: "Rezku daily email reports · verified 3 PM allocation rules",
    weekStart,
    weekEnd: new Date(bounds.end.getTime() - 1).toISOString(),
    rows,
    tipDetails: tipDetails.slice(-500).reverse(),
  };
}

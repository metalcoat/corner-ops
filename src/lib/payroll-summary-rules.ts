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
  allocationTime: Date;
  transactionTime: Date | null;
  tip: number;
  orderType: string;
  orderMatched: boolean;
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

function normalizedOrderId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/\.0+$/, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function rawObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Ignore malformed legacy raw values.
    }
  }
  return {};
}

function rawHasClock(value: unknown, fields: string[]): boolean {
  const raw = rawObject(value);
  return fields.some((field) => /\d{1,2}:\d{2}/.test(String(raw[field] || "")));
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
  const time = transaction.allocationTime;
  const sameDay = shifts.filter((shift) => isEligible(shift)
    && predicate(shift)
    && shift.clockOut
    && localDayKey(shift.clockOut) === localDayKey(time));
  const alreadyOut = sameDay.filter((shift) => (shift.clockOut?.getTime() || 0) <= time.getTime());
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

function detailBase(transaction: Transaction, totalCents: number) {
  return {
    time: (transaction.transactionTime || transaction.allocationTime).toISOString(),
    orderOpenedAt: transaction.allocationTime.toISOString(),
    transactionTime: transaction.transactionTime?.toISOString() || null,
    orderId: transaction.orderId,
    orderType: transaction.orderType,
    originalTip: transaction.tip,
    tipAfterFee: totalCents / 100,
  };
}

function allocateTips(shifts: Shift[], transactions: Transaction[], summary: Map<string, SummaryRow>) {
  const details: Array<Record<string, unknown>> = [];

  for (const transaction of transactions) {
    const totalCents = Math.round(transaction.tip * TIP_MULTIPLIER * 100);
    if (!totalCents) continue;

    if (!transaction.orderMatched) {
      details.push({
        ...detailBase(transaction, totalCents),
        orderType: "",
        allocatedTip: 0,
        employee: "Unallocated",
        splitCount: 0,
        rule: "Not allocated: Transaction Export Order ID did not match an Order Export ID",
      });
      continue;
    }

    const delivery = /deliver/i.test(transaction.orderType);
    const pickup = /pick\s*up|pickup|take\s*out|takeout|carry\s*out|carryout|to\s*go|togo|counter/i.test(transaction.orderType);
    if (!delivery && !pickup) {
      details.push({
        ...detailBase(transaction, totalCents),
        allocatedTip: 0,
        employee: "Unallocated",
        splitCount: 0,
        rule: "Not allocated: matched Order Export row did not identify delivery or pickup",
      });
      continue;
    }

    const time = transaction.allocationTime;
    const beforeThree = localHour(time) < CUTOFF_HOUR;
    let eligible: Shift[] = [];
    let rule = "";

    if (beforeThree) {
      eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && covers(shift, time)));
      rule = "Before 3 PM order: equally split among all tip-eligible employees clocked in";
    } else if (delivery) {
      eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && isDriver(shift) && covers(shift, time)));
      if (eligible.length) {
        rule = "After 3 PM delivery order: assigned to driver clocked in";
      } else {
        const graceEnd = time.getTime() + DRIVER_GRACE_MINUTES * 60_000;
        eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift)
          && isDriver(shift)
          && shift.clockIn
          && shift.clockIn.getTime() > time.getTime()
          && shift.clockIn.getTime() <= graceEnd));
        if (eligible.length) rule = "After 3 PM delivery order: driver arrived within 35 minutes";
      }
      if (!eligible.length) {
        eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && !isDriver(shift) && covers(shift, time)));
        rule = "After 3 PM delivery fallback: equally split among non-driver employees clocked in";
      }
    } else {
      eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && !isDriver(shift) && covers(shift, time)));
      rule = "After 3 PM pickup order: equally split among non-driver employees clocked in";
    }

    if (!eligible.length) {
      const predicate = beforeThree
        ? (_shift: Shift) => true
        : (shift: Shift) => !isDriver(shift);
      eligible = lastSignedOut(shifts, transaction, predicate);
      rule = beforeThree
        ? "Before 3 PM after-close fallback: equally split among employees who signed out last"
        : delivery
          ? "After 3 PM delivery fallback: equally split among non-drivers who signed out last"
          : "After 3 PM pickup fallback: equally split among non-drivers who signed out last";
    }

    if (!eligible.length) {
      details.push({
        ...detailBase(transaction, totalCents),
        allocatedTip: 0,
        employee: "Unallocated",
        splitCount: 0,
        rule: "Not allocated: no eligible employee was clocked in or available for fallback",
      });
      continue;
    }

    const allocations = splitCents(totalCents, eligible.length);
    eligible.forEach((shift, index) => {
      const amount = allocations[index] / 100;
      const row = rowFor(summary, shift.employeeName);
      row.tips = Math.round((row.tips + amount) * 100) / 100;
      if (delivery) row.deliveryTips = Math.round((row.deliveryTips + amount) * 100) / 100;
      else row.pickupTips = Math.round((row.pickupTips + amount) * 100) / 100;
      details.push({
        ...detailBase(transaction, totalCents),
        allocatedTip: amount,
        employee: canonicalEmployeeName(shift.employeeName),
        splitCount: eligible.length,
        rule,
      });
    });
  }

  return details;
}

function deduplicateTransactionRows(rows: Array<Record<string, unknown>>) {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const orderKey = normalizedOrderId(row.order_id);
    const key = `${orderKey}|${Math.round(numberValue(row.tip) * 100)}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const result: Array<Record<string, unknown>> = [];
  for (const group of groups.values()) {
    const detailed = group.filter((row) => rawHasClock(row.raw, ["Transaction Time", "Payment Time", "Created At", "Time"]));
    if (detailed.length) {
      result.push(...detailed);
    } else {
      // Multiple report versions can contain the same date-only payment. Keep one until a timed row arrives.
      result.push(group[0]);
    }
  }
  return result;
}

export async function payrollSummary(business: Business, weekStart: string) {
  if (business === "Tiki") return legacyPayrollSummary(business, weekStart);

  const bounds = weekBounds(weekStart);
  const transactionSearchStart = new Date(bounds.start.getTime() - 24 * 60 * 60 * 1000);
  const transactionSearchEnd = new Date(bounds.end.getTime() + 24 * 60 * 60 * 1000);
  const shiftRows = await getSql()`
    SELECT id, employee_name, position, role_group, clock_in, clock_out, reported_hours
    FROM rezku_shifts
    WHERE clock_in >= ${bounds.start.toISOString()}
      AND clock_in < ${bounds.end.toISOString()}
    ORDER BY clock_in
  ` as unknown as Array<Record<string, unknown>>;
  const orderRows = await getSql()`
    SELECT order_id, opened_at, order_type, raw
    FROM rezku_orders
    WHERE opened_at >= ${bounds.start.toISOString()}
      AND opened_at < ${bounds.end.toISOString()}
    ORDER BY opened_at
  ` as unknown as Array<Record<string, unknown>>;
  const rawTransactionRows = await getSql()`
    SELECT id, order_id, transaction_time, tip, raw
    FROM rezku_transactions
    WHERE transaction_time >= ${transactionSearchStart.toISOString()}
      AND transaction_time < ${transactionSearchEnd.toISOString()}
      AND tip <> 0
    ORDER BY transaction_time
  ` as unknown as Array<Record<string, unknown>>;
  const transactionRows = deduplicateTransactionRows(rawTransactionRows);

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

  const orders = new Map<string, { orderType: string; openedAt: Date; hasClock: boolean }>();
  for (const row of orderRows) {
    const key = normalizedOrderId(row.order_id);
    const openedAt = dateValue(row.opened_at);
    if (!key || !openedAt) continue;
    const candidate = {
      orderType: String(row.order_type || "").trim(),
      openedAt,
      hasClock: rawHasClock(row.raw, ["Opened At", "Open Time", "Order Time", "Created At", "Time"]),
    };
    const existing = orders.get(key);
    if (!existing
      || (!existing.hasClock && candidate.hasClock)
      || (existing.hasClock === candidate.hasClock && existing.openedAt.getTime() < candidate.openedAt.getTime())) {
      orders.set(key, candidate);
    }
  }

  const transactions: Transaction[] = transactionRows
    .map((row) => {
      const transactionTime = dateValue(row.transaction_time);
      const orderId = String(row.order_id || "").trim();
      const orderKey = normalizedOrderId(orderId);
      const order = orderKey ? orders.get(orderKey) : undefined;
      const allocationTime = order?.openedAt || transactionTime;
      if (!allocationTime || allocationTime < bounds.start || allocationTime >= bounds.end) return null;
      return {
        id: String(row.id),
        orderId,
        allocationTime,
        transactionTime,
        tip: numberValue(row.tip),
        orderType: order?.orderType || "",
        orderMatched: Boolean(order),
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
  const tipJoinIssues = tipDetails.filter((detail) => detail.employee === "Unallocated");

  return {
    business,
    source: "Rezku daily email reports · Transaction Export tips joined to Order Export type and opened time",
    weekStart,
    weekEnd: new Date(bounds.end.getTime() - 1).toISOString(),
    rows,
    tipDetails: tipDetails.slice(-500).reverse(),
    tipJoinIssues: tipJoinIssues.slice(-200).reverse(),
  };
}

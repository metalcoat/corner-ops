import { getSql } from "@/lib/db";
import { payrollSummary as legacyPayrollSummary } from "@/lib/operations";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const TIP_MULTIPLIER = 0.965;
const CUTOFF_HOUR = 15;
const DRIVER_GRACE_MINUTES = 35;
const LATE_TIP_LOOKAHEAD_DAYS = 14;

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
  tipsBeforeFee: number;
  pickupTipsBeforeFee: number;
  deliveryTipsBeforeFee: number;
  tips: number;
  pickupTips: number;
  deliveryTips: number;
};

type PendingAllocation = {
  transaction: Transaction;
  employeeName: string;
  splitCount: number;
  rule: string;
  delivery: boolean;
  grossCents: number;
  netCents: number;
};

type DailySource = {
  date: string;
  sourceGrossCents: number;
  deliveryGrossCents: number;
  pickupGrossCents: number;
  unclassifiedGrossCents: number;
};

type ScheduledDriver = {
  employeeName: string;
  position: string;
  startsAt: Date;
  endsAt: Date;
};

type DriverCoverageWarning = {
  date: string;
  orderCount: number;
  tipsBeforeFee: number;
  scheduledDrivers: string[];
  message: string;
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

function normalizedTransactionId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/\.0+$/, "")
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

function rawOrderHasClock(value: unknown): boolean {
  const raw = rawObject(value);
  const exact = ["Order Opened At", "Order Opened", "Opened At", "Opened", "Open Time", "Order Time", "Created At", "Time"]
    .some((field) => /\d{1,2}:\d{2}/.test(String(raw[field] || "")));
  if (exact) return true;
  return Object.entries(raw).some(([key, fieldValue]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (normalized.includes("opened") || normalized.includes("opentime") || normalized.includes("orderopen"))
      && /\d{1,2}:\d{2}/.test(String(fieldValue || ""));
  });
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

function isDriverPosition(position: string): boolean {
  return /\b(driver|delivery|deliveries)\b/i.test(position);
}

function isDriver(shift: Shift): boolean {
  return shift.roleGroup === "Driver" || isDriverPosition(shift.position);
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

function nextDriversWithinGrace(shifts: Shift[], time: Date): Shift[] {
  const graceEnd = time.getTime() + DRIVER_GRACE_MINUTES * 60_000;
  const candidates = shifts.filter((shift) => isEligible(shift)
    && isDriver(shift)
    && shift.clockIn
    && shift.clockIn.getTime() > time.getTime()
    && shift.clockIn.getTime() <= graceEnd);
  if (!candidates.length) return [];
  const earliestClockIn = Math.min(...candidates.map((shift) => shift.clockIn?.getTime() || Number.MAX_SAFE_INTEGER));
  return uniqueEmployees(candidates.filter((shift) => shift.clockIn?.getTime() === earliestClockIn));
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
    tipsBeforeFee: 0,
    pickupTipsBeforeFee: 0,
    deliveryTipsBeforeFee: 0,
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

function detailBase(transaction: Transaction) {
  return {
    time: (transaction.transactionTime || transaction.allocationTime).toISOString(),
    orderOpenedAt: transaction.allocationTime.toISOString(),
    transactionTime: transaction.transactionTime?.toISOString() || null,
    orderId: transaction.orderId,
    orderType: transaction.orderType,
    originalTip: transaction.tip,
  };
}

function classifyTransaction(transaction: Transaction) {
  const delivery = /deliver/i.test(transaction.orderType);
  const pickup = /pick\s*up|pickup|take\s*out|takeout|carry\s*out|carryout|to\s*go|togo|counter/i.test(transaction.orderType);
  return { delivery, pickup };
}

function recordDailySource(source: Map<string, DailySource>, transaction: Transaction) {
  const date = localDayKey(transaction.allocationTime);
  const grossCents = Math.round(transaction.tip * 100);
  const current = source.get(date) || {
    date,
    sourceGrossCents: 0,
    deliveryGrossCents: 0,
    pickupGrossCents: 0,
    unclassifiedGrossCents: 0,
  };
  current.sourceGrossCents += grossCents;
  const { delivery, pickup } = classifyTransaction(transaction);
  if (transaction.orderMatched && delivery) current.deliveryGrossCents += grossCents;
  else if (transaction.orderMatched && pickup) current.pickupGrossCents += grossCents;
  else current.unclassifiedGrossCents += grossCents;
  source.set(date, current);
}

function distributeDailyFee(allocations: PendingAllocation[]) {
  const byDay = new Map<string, PendingAllocation[]>();
  for (const allocation of allocations) {
    const date = localDayKey(allocation.transaction.allocationTime);
    const group = byDay.get(date) || [];
    group.push(allocation);
    byDay.set(date, group);
  }

  for (const group of byDay.values()) {
    const targetNetCents = Math.round(group.reduce((total, allocation) => total + allocation.grossCents, 0) * TIP_MULTIPLIER);
    const ranked = group.map((allocation, index) => {
      const exact = allocation.grossCents * TIP_MULTIPLIER;
      allocation.netCents = Math.trunc(exact);
      return { index, fraction: exact - allocation.netCents };
    });
    let difference = targetNetCents - group.reduce((total, allocation) => total + allocation.netCents, 0);
    ranked.sort((left, right) => difference >= 0
      ? right.fraction - left.fraction || left.index - right.index
      : left.fraction - right.fraction || left.index - right.index);
    const direction = difference < 0 ? -1 : 1;
    difference = Math.abs(difference);
    for (let index = 0; index < difference; index += 1) {
      group[ranked[index % ranked.length].index].netCents += direction;
    }
  }
}

function allocateTips(shifts: Shift[], transactions: Transaction[], summary: Map<string, SummaryRow>) {
  const details: Array<Record<string, unknown>> = [];
  const pending: PendingAllocation[] = [];
  const dailySource = new Map<string, DailySource>();

  for (const transaction of transactions) {
    recordDailySource(dailySource, transaction);
    const grossCents = Math.round(transaction.tip * 100);
    if (!grossCents) continue;

    if (!transaction.orderMatched) {
      details.push({
        ...detailBase(transaction),
        allocatedTipBeforeFee: 0,
        feeAmount: 0,
        allocatedTip: 0,
        employee: "Unallocated",
        splitCount: 0,
        rule: "Not allocated: Transaction Export Order ID did not match an Order Export ID",
      });
      continue;
    }

    const { delivery, pickup } = classifyTransaction(transaction);
    if (!delivery && !pickup) {
      details.push({
        ...detailBase(transaction),
        allocatedTipBeforeFee: 0,
        feeAmount: 0,
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
        eligible = nextDriversWithinGrace(shifts, time);
        if (eligible.length) {
          rule = "After 3 PM delivery order: next driver arrived within 35 minutes";
        } else {
          eligible = uniqueEmployees(shifts.filter((shift) => isEligible(shift) && !isDriver(shift) && covers(shift, time)));
          rule = "After 3 PM delivery fallback: no driver clocked in or arriving within 35 minutes; equally split among non-driver employees clocked in";
        }
      }

      if (!eligible.length) {
        details.push({
          ...detailBase(transaction),
          allocatedTipBeforeFee: 0,
          feeAmount: 0,
          allocatedTip: 0,
          employee: "Unallocated",
          splitCount: 0,
          rule: "After 3 PM delivery: no driver within 35 minutes and no other tip-eligible employee was clocked in",
        });
        continue;
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
        : "After 3 PM pickup fallback: equally split among non-drivers who signed out last";
    }

    if (!eligible.length) {
      details.push({
        ...detailBase(transaction),
        allocatedTipBeforeFee: 0,
        feeAmount: 0,
        allocatedTip: 0,
        employee: "Unallocated",
        splitCount: 0,
        rule: "Not allocated: no eligible employee was clocked in or available for fallback",
      });
      continue;
    }

    const grossAllocations = splitCents(grossCents, eligible.length);
    eligible.forEach((shift, index) => {
      pending.push({
        transaction,
        employeeName: canonicalEmployeeName(shift.employeeName),
        splitCount: eligible.length,
        rule,
        delivery,
        grossCents: grossAllocations[index],
        netCents: 0,
      });
    });
  }

  distributeDailyFee(pending);

  for (const allocation of pending) {
    const grossAmount = allocation.grossCents / 100;
    const netAmount = allocation.netCents / 100;
    const row = rowFor(summary, allocation.employeeName);
    row.tipsBeforeFee = Math.round((row.tipsBeforeFee + grossAmount) * 100) / 100;
    row.tips = Math.round((row.tips + netAmount) * 100) / 100;
    if (allocation.delivery) {
      row.deliveryTipsBeforeFee = Math.round((row.deliveryTipsBeforeFee + grossAmount) * 100) / 100;
      row.deliveryTips = Math.round((row.deliveryTips + netAmount) * 100) / 100;
    } else {
      row.pickupTipsBeforeFee = Math.round((row.pickupTipsBeforeFee + grossAmount) * 100) / 100;
      row.pickupTips = Math.round((row.pickupTips + netAmount) * 100) / 100;
    }
    details.push({
      ...detailBase(allocation.transaction),
      allocatedTipBeforeFee: grossAmount,
      feeAmount: (allocation.grossCents - allocation.netCents) / 100,
      allocatedTip: netAmount,
      employee: allocation.employeeName,
      splitCount: allocation.splitCount,
      rule: allocation.rule,
    });
  }

  const pendingByDay = new Map<string, PendingAllocation[]>();
  for (const allocation of pending) {
    const date = localDayKey(allocation.transaction.allocationTime);
    const group = pendingByDay.get(date) || [];
    group.push(allocation);
    pendingByDay.set(date, group);
  }

  const dailyTipReconciliation = [...dailySource.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((source) => {
      const allocations = pendingByDay.get(source.date) || [];
      const allocatedGrossCents = allocations.reduce((total, allocation) => total + allocation.grossCents, 0);
      const allocatedNetCents = allocations.reduce((total, allocation) => total + allocation.netCents, 0);
      const expectedNetCents = Math.round(allocatedGrossCents * TIP_MULTIPLIER);
      const unallocatedGrossCents = source.sourceGrossCents - allocatedGrossCents;
      const balanceCents = allocatedNetCents - expectedNetCents;
      return {
        date: source.date,
        sourceTipsBeforeFee: source.sourceGrossCents / 100,
        deliveryTipsBeforeFee: source.deliveryGrossCents / 100,
        pickupTipsBeforeFee: source.pickupGrossCents / 100,
        unclassifiedTipsBeforeFee: source.unclassifiedGrossCents / 100,
        allocatedTipsBeforeFee: allocatedGrossCents / 100,
        unallocatedTipsBeforeFee: unallocatedGrossCents / 100,
        feeAmount: (allocatedGrossCents - expectedNetCents) / 100,
        expectedAfterFee: expectedNetCents / 100,
        allocatedAfterFee: allocatedNetCents / 100,
        balance: balanceCents / 100,
        status: unallocatedGrossCents === 0 && balanceCents === 0 ? "Balanced" : "Needs review",
      };
    });

  return { details, dailyTipReconciliation };
}

function deduplicateTransactionRows(rows: Array<Record<string, unknown>>) {
  const selected = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const transactionId = normalizedTransactionId(row.transaction_id);
    const orderKey = normalizedOrderId(row.order_id);
    const transactionTime = dateValue(row.transaction_time);
    const tipCents = Math.round(numberValue(row.tip) * 100);
    const key = transactionId
      ? `transaction|${transactionId}|${orderKey}`
      : `fallback|${orderKey}|${transactionTime?.toISOString() || "no-time"}|${tipCents}`;

    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, row);
      continue;
    }

    const existingHasClock = rawHasClock(existing.raw, ["Transaction Time", "Payment Time", "Created At", "Time"]);
    const candidateHasClock = rawHasClock(row.raw, ["Transaction Time", "Payment Time", "Created At", "Time"]);
    if (!existingHasClock && candidateHasClock) selected.set(key, row);
  }

  return [...selected.values()].sort((left, right) => {
    const leftTime = dateValue(left.transaction_time)?.getTime() || 0;
    const rightTime = dateValue(right.transaction_time)?.getTime() || 0;
    return leftTime - rightTime;
  });
}

async function scheduledDriversForWeek(business: Business, start: Date, end: Date): Promise<ScheduledDriver[]> {
  if (business !== "Corner Deli") return [];
  try {
    const scheduleEnd = new Date(end.getTime() + DRIVER_GRACE_MINUTES * 60_000);
    const rows = await getSql()`
      SELECT s.position, s.starts_at, s.ends_at, e.name AS employee_name, e.position AS employee_position
      FROM schedule_shifts s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.business = ${business}
        AND s.status = 'Published'
        AND s.starts_at < ${scheduleEnd.toISOString()}
        AND s.ends_at > ${start.toISOString()}
      ORDER BY s.starts_at
    ` as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const startsAt = dateValue(row.starts_at);
      const endsAt = dateValue(row.ends_at);
      const scheduledPosition = String(row.position || "").trim();
      const employeePosition = String(row.employee_position || "").trim();
      return {
        employeeName: canonicalEmployeeName(row.employee_name),
        position: scheduledPosition || employeePosition,
        startsAt,
        endsAt,
        driverPosition: isDriverPosition(scheduledPosition) || isDriverPosition(employeePosition),
      };
    }).filter((row): row is ScheduledDriver & { driverPosition: true } => Boolean(
      row.employeeName && row.startsAt && row.endsAt && row.driverPosition,
    )).map((row) => ({
      employeeName: row.employeeName,
      position: row.position,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    }));
  } catch {
    return [];
  }
}

function driverCoverageWarnings(
  details: Array<Record<string, unknown>>,
  scheduledDrivers: ScheduledDriver[],
): DriverCoverageWarning[] {
  const byDay = new Map<string, {
    orderKeys: Set<string>;
    tipsCents: number;
    scheduledDrivers: Set<string>;
  }>();

  for (const detail of details) {
    if (!String(detail.rule || "").startsWith("After 3 PM delivery fallback:")) continue;
    const openedAt = dateValue(detail.orderOpenedAt);
    if (!openedAt) continue;
    const date = localDayKey(openedAt);
    const current = byDay.get(date) || {
      orderKeys: new Set<string>(),
      tipsCents: 0,
      scheduledDrivers: new Set<string>(),
    };
    const orderKey = `${String(detail.orderId || "")}|${openedAt.toISOString()}|${String(detail.transactionTime || "")}`;
    if (!current.orderKeys.has(orderKey)) {
      current.orderKeys.add(orderKey);
      current.tipsCents += Math.round(numberValue(detail.originalTip) * 100);
    }

    const graceEnd = openedAt.getTime() + DRIVER_GRACE_MINUTES * 60_000;
    for (const scheduled of scheduledDrivers) {
      if (scheduled.startsAt.getTime() <= graceEnd && scheduled.endsAt.getTime() >= openedAt.getTime()) {
        current.scheduledDrivers.add(scheduled.employeeName);
      }
    }
    byDay.set(date, current);
  }

  return [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .filter(([, value]) => value.scheduledDrivers.size > 0)
    .map(([date, value]) => {
      const names = [...value.scheduledDrivers].sort();
      return {
        date,
        orderCount: value.orderKeys.size,
        tipsBeforeFee: value.tipsCents / 100,
        scheduledDrivers: names,
        message: `Driver punch missing: ${names.join(", ")} was scheduled as Driver, but no qualifying Driver punch covered these deliveries or started within 35 minutes. Tips fell back to the tip-eligible staff actually clocked in.`,
      };
    });
}

export async function payrollSummary(business: Business, weekStart: string) {
  if (business === "Tiki") return legacyPayrollSummary(business, weekStart);

  const bounds = weekBounds(weekStart);
  const transactionSearchStart = new Date(bounds.start.getTime() - 24 * 60 * 60 * 1000);
  const transactionSearchEnd = new Date(bounds.end.getTime() + LATE_TIP_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const orderSearchStart = new Date(bounds.start.getTime() - LATE_TIP_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const orderSearchEnd = new Date(bounds.end.getTime() + 24 * 60 * 60 * 1000);

  const [shiftRows, orderRows, rawTransactionRows, scheduledDrivers] = await Promise.all([
    getSql()`
      SELECT id, employee_name, position, role_group, clock_in, clock_out, reported_hours
      FROM rezku_shifts
      WHERE clock_in >= ${bounds.start.toISOString()}
        AND clock_in < ${bounds.end.toISOString()}
      ORDER BY clock_in
    `,
    getSql()`
      SELECT order_id, opened_at, order_type, raw
      FROM rezku_orders
      WHERE opened_at >= ${orderSearchStart.toISOString()}
        AND opened_at < ${orderSearchEnd.toISOString()}
      ORDER BY opened_at
    `,
    getSql()`
      SELECT id, transaction_id, order_id, transaction_time, tip, raw
      FROM rezku_transactions
      WHERE transaction_time >= ${transactionSearchStart.toISOString()}
        AND transaction_time < ${transactionSearchEnd.toISOString()}
        AND tip <> 0
      ORDER BY transaction_time
    `,
    scheduledDriversForWeek(business, bounds.start, bounds.end),
  ]) as unknown as [
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
    ScheduledDriver[],
  ];

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
      hasClock: rawOrderHasClock(row.raw),
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
  const allocation = allocateTips(shifts, transactions, summary);
  const coverageWarnings = driverCoverageWarnings(allocation.details, scheduledDrivers);
  const warningByDate = new Map(coverageWarnings.map((warning) => [warning.date, warning]));
  const dailyTipReconciliation = allocation.dailyTipReconciliation.map((day) => {
    const warning = warningByDate.get(day.date);
    if (!warning) return day;
    return {
      ...day,
      status: warning.scheduledDrivers.length ? "Driver punch missing" : "No driver coverage",
    };
  });

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
        tipsBeforeFee: Math.round(row.tipsBeforeFee * 100) / 100,
        pickupTipsBeforeFee: Math.round(row.pickupTipsBeforeFee * 100) / 100,
        deliveryTipsBeforeFee: Math.round(row.deliveryTipsBeforeFee * 100) / 100,
        tips: Math.round(row.tips * 100) / 100,
        pickupTips: Math.round(row.pickupTips * 100) / 100,
        deliveryTips: Math.round(row.deliveryTips * 100) / 100,
      };
    })
    .sort((left, right) => left.employee.localeCompare(right.employee));

  const tipJoinIssues = allocation.details.filter((detail) => detail.employee === "Unallocated");

  return {
    business,
    source: "Rezku daily email reports · tips allocated by Order Export opened time · 35-minute future-driver grace · then staff fallback",
    weekStart,
    weekEnd: new Date(bounds.end.getTime() - 1).toISOString(),
    rows,
    tipDetails: allocation.details.slice(-500).reverse(),
    tipJoinIssues: tipJoinIssues.slice(-200).reverse(),
    driverCoverageWarnings: coverageWarnings,
    dailyTipReconciliation,
  };
}

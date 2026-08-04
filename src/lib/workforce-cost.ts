import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { getSql } from "@/lib/db";
import { ensureScheduleMealSchema } from "@/lib/schedule-meal-storage";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

type CostRow = {
  id: string;
  employee_id: string | null;
  employee_name: string | null;
  position: string;
  starts_at: string | Date;
  ends_at: string | Date;
  meal_break_minutes: number | string | null;
  extra_meal_break_minutes: number | string | null;
  hourly_rate: number | string | null;
  tipped_rate: number | string | null;
};

function validMonday(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid Monday.");
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDay() !== 1) throw new Error("Payroll estimate weeks must start on Monday.");
  return value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function deliveryPosition(value: unknown): boolean {
  return /\b(driver|delivery|deliveries)\b/i.test(String(value || ""));
}

function round(value: number, digits = 2): number {
  const power = 10 ** digits;
  return Math.round((value + Number.EPSILON) * power) / power;
}

function hours(row: CostRow): number {
  const start = new Date(row.starts_at).getTime();
  const end = new Date(row.ends_at).getTime();
  const unpaidMinutes = Math.max(0, Number(row.meal_break_minutes || 0)) + Math.max(0, Number(row.extra_meal_break_minutes || 0));
  return Math.max(0, (end - start) / 3_600_000 - unpaidMinutes / 60);
}

export async function scheduledPayrollEstimate(business: Business, requestedWeekStart: string) {
  await ensureEmployeeDirectorySchema();
  await ensureScheduleMealSchema();
  const weekStart = validMonday(requestedWeekStart);
  const weekEndExclusive = addDays(weekStart, 7);
  const rows = await getSql()`
    SELECT s.id, s.employee_id, e.name AS employee_name, s.position,
      s.starts_at, s.ends_at, s.meal_break_minutes, s.extra_meal_break_minutes,
      e.hourly_rate, e.tipped_rate
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${business}
      AND s.starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < (${weekEndExclusive}::date AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
    ORDER BY e.name NULLS LAST, s.starts_at
  ` as unknown as CostRow[];

  const assigned = rows.filter((row) => row.employee_id);
  const open = rows.filter((row) => !row.employee_id);
  const employeeHours = new Map<string, number>();
  let grossWages = 0;
  let paidHours = 0;
  let regularHours = 0;
  let overtimeHours = 0;
  let deliveryHours = 0;
  let deliveryWages = 0;
  let missingRateHours = 0;

  for (const row of assigned) {
    const shiftHours = hours(row);
    const normalRate = Math.max(0, Number(row.hourly_rate || 0));
    const deliveryRate = Math.max(0, Number(row.tipped_rate || 0));
    const isDelivery = deliveryPosition(row.position);
    const rate = isDelivery ? deliveryRate : normalRate;
    const prior = employeeHours.get(row.employee_id!) || 0;
    const regular = Math.max(0, Math.min(shiftHours, 40 - prior));
    const overtime = Math.max(0, shiftHours - regular);
    employeeHours.set(row.employee_id!, prior + shiftHours);

    paidHours += shiftHours;
    regularHours += regular;
    overtimeHours += overtime;
    if (isDelivery) deliveryHours += shiftHours;
    if (rate <= 0) {
      missingRateHours += shiftHours;
      continue;
    }
    const shiftCost = regular * rate + overtime * rate * 1.5;
    grossWages += shiftCost;
    if (isDelivery) deliveryWages += shiftCost;
  }

  const employeeCount = new Set(assigned.map((row) => row.employee_id)).size;
  return {
    business,
    weekStart,
    weekEnd: addDays(weekStart, 6),
    shiftCount: rows.length,
    assignedShiftCount: assigned.length,
    openShiftCount: open.length,
    employeeCount,
    paidHours: round(paidHours),
    regularHours: round(regularHours),
    overtimeHours: round(overtimeHours),
    deliveryHours: round(deliveryHours),
    grossWages: round(grossWages),
    deliveryWages: round(deliveryWages),
    missingRateHours: round(missingRateHours),
    includesEmployerTaxes: false,
    note: "Estimated scheduled gross wages before employer payroll taxes, tips, reimbursements, and payroll-provider fees. Scheduled unpaid meal periods are excluded.",
  };
}

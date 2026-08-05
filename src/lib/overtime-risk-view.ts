import { analyzeShiftMealCompliance } from "@/lib/schedule-meal-compliance";
import { getSql } from "@/lib/db";
import {
  evaluateAndNotifyOvertimeRisk,
  overtimeRiskDashboard,
} from "@/lib/overtime-risk";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const START_TOLERANCE_MS = 90 * 60 * 1000;
const END_TOLERANCE_MS = 120 * 60 * 1000;
const MIN_OVERLAP_MS = 15 * 60 * 1000;

type ScheduleRow = {
  id: string;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  meal_break_start: string | null;
  meal_break_minutes: number;
  extra_meal_break_start: string | null;
  extra_meal_break_minutes: number;
};

type CoverageItem = {
  actualEntryId: string;
  actualEmployeeId: string | null;
  actualEmployeeName: string;
  scheduledEmployeeId: string | null;
  scheduledEmployeeName: string;
  scheduledShiftId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  hours: number;
  kind: string;
  detail: string;
};

function roundHours(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function localDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function expectedPaidHoursToDate(shift: ScheduleRow, nowMs: number): number {
  const startMs = new Date(shift.starts_at).getTime();
  const endMs = new Date(shift.ends_at).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || nowMs <= startMs) return 0;

  const full = analyzeShiftMealCompliance({
    startsAt: shift.starts_at,
    endsAt: shift.ends_at,
    mealBreakStart: shift.meal_break_start,
    mealBreakMinutes: Number(shift.meal_break_minutes || 0),
    extraMealBreakStart: shift.extra_meal_break_start,
    extraMealBreakMinutes: Number(shift.extra_meal_break_minutes || 0),
  }).paidHours;
  if (nowMs >= endMs) return full;

  let elapsedMs = nowMs - startMs;
  for (const meal of [
    shift.meal_break_start && shift.meal_break_minutes
      ? { start: new Date(shift.meal_break_start).getTime(), minutes: Number(shift.meal_break_minutes) }
      : null,
    shift.extra_meal_break_start && shift.extra_meal_break_minutes
      ? { start: new Date(shift.extra_meal_break_start).getTime(), minutes: Number(shift.extra_meal_break_minutes) }
      : null,
  ]) {
    if (!meal || !Number.isFinite(meal.start)) continue;
    const mealEnd = meal.start + meal.minutes * 60_000;
    const overlap = Math.max(0, Math.min(nowMs, mealEnd) - Math.max(startMs, meal.start));
    elapsedMs -= overlap;
  }
  return roundHours(Math.max(0, elapsedMs / 3_600_000));
}

function minorSameEmployeeTimingDifference(item: CoverageItem, shifts: ScheduleRow[]): boolean {
  if (!item.actualEmployeeId || !item.startsAt) return false;
  if (item.kind !== "Covered another employee" && item.kind !== "Unscheduled") return false;

  const actualStart = new Date(item.startsAt).getTime();
  const actualEnd = item.endsAt
    ? new Date(item.endsAt).getTime()
    : actualStart + Math.max(0, Number(item.hours || 0)) * 3_600_000;
  if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd) || actualEnd <= actualStart) return false;
  const actualDay = localDate(item.startsAt);

  return shifts.some((shift) => {
    if (shift.employee_id !== item.actualEmployeeId || localDate(shift.starts_at) !== actualDay) return false;
    const scheduledStart = new Date(shift.starts_at).getTime();
    const scheduledEnd = new Date(shift.ends_at).getTime();
    if (!Number.isFinite(scheduledStart) || !Number.isFinite(scheduledEnd)) return false;

    const overlap = Math.min(actualEnd, scheduledEnd) - Math.max(actualStart, scheduledStart);
    const startDifference = Math.abs(actualStart - scheduledStart);
    const endDifference = Math.abs(actualEnd - scheduledEnd);
    return overlap >= MIN_OVERLAP_MS
      || (startDifference <= START_TOLERANCE_MS && endDifference <= END_TOLERANCE_MS);
  });
}

async function enhanceDashboard<T extends Awaited<ReturnType<typeof overtimeRiskDashboard>>>(
  dashboard: T,
): Promise<T & { suppressedMinorTimingDifferences: number; paceAsOf: string }> {
  const sql = getSql();
  const scheduleRows = await sql`
    SELECT id, employee_id, starts_at, ends_at, meal_break_start, meal_break_minutes,
      extra_meal_break_start, extra_meal_break_minutes
    FROM schedule_shifts
    WHERE business = ${dashboard.business}
      AND starts_at >= (${dashboard.weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${dashboard.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND status <> 'Cancelled'
    ORDER BY starts_at
  ` as unknown as ScheduleRow[];

  const originalMismatches = dashboard.coverageMismatches as unknown as CoverageItem[];
  const coverageMismatches = originalMismatches.filter(
    (item) => !minorSameEmployeeTimingDifference(item, scheduleRows),
  );
  const suppressedMinorTimingDifferences = originalMismatches.length - coverageMismatches.length;

  const unplannedByEmployee = new Map<string, number>();
  for (const mismatch of coverageMismatches) {
    if (!mismatch.actualEmployeeId) continue;
    unplannedByEmployee.set(
      mismatch.actualEmployeeId,
      roundHours((unplannedByEmployee.get(mismatch.actualEmployeeId) || 0) + Number(mismatch.hours || 0)),
    );
  }

  const nowMs = new Date(dashboard.generatedAt).getTime();
  const expectedByEmployee = new Map<string, number>();
  for (const shift of scheduleRows) {
    if (!shift.employee_id) continue;
    expectedByEmployee.set(
      shift.employee_id,
      roundHours((expectedByEmployee.get(shift.employee_id) || 0) + expectedPaidHoursToDate(shift, nowMs)),
    );
  }

  const risks = dashboard.risks.map((risk) => {
    const expectedHoursToDate = roundHours(expectedByEmployee.get(risk.employeeId) || 0);
    const paceDeltaHours = roundHours(Number(risk.actualHours || 0) - expectedHoursToDate);
    const paceStatus = paceDeltaHours > 0.5
      ? "ahead"
      : paceDeltaHours < -0.5
        ? "behind"
        : "on-pace";
    return {
      ...risk,
      unplannedHours: roundHours(unplannedByEmployee.get(risk.employeeId) || 0),
      expectedHoursToDate,
      paceDeltaHours,
      paceStatus,
    };
  });

  return {
    ...dashboard,
    summary: {
      ...dashboard.summary,
      coverageMismatches: coverageMismatches.length,
    },
    risks,
    coverageMismatches: coverageMismatches as T["coverageMismatches"],
    suppressedMinorTimingDifferences,
    paceAsOf: dashboard.generatedAt,
  };
}

export async function overtimeRiskDashboardView(business: Business, requestedWeekStart?: string) {
  return enhanceDashboard(await overtimeRiskDashboard(business, requestedWeekStart));
}

export async function evaluateAndNotifyOvertimeRiskView(input: {
  business: Business;
  source?: string;
  notify?: boolean;
}) {
  return enhanceDashboard(await evaluateAndNotifyOvertimeRisk(input));
}

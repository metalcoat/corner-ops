import { analyzeShiftMealCompliance, newYorkDateKey } from "@/lib/schedule-meal-compliance";

export type ScheduleValidationShift = {
  id: string;
  employeeId: string | null;
  employeeName?: string;
  startsAt: string;
  endsAt: string;
  mealBreakStart?: string | null;
  mealBreakMinutes?: number | null;
  extraMealBreakStart?: string | null;
  extraMealBreakMinutes?: number | null;
  status?: string;
};

export type HourRisk = "normal" | "warning" | "overtime";

type WorkSegment = {
  startMs: number;
  endMs: number;
  shiftId: string;
};

type NormalizedShift = ScheduleValidationShift & {
  startMs: number;
  endMs: number;
  hours: number;
  workSegments: WorkSegment[];
};

export type ScheduleOverlap = {
  employeeId: string;
  employeeName: string;
  firstShiftId: string;
  secondShiftId: string;
  startsAt: string;
  endsAt: string;
};

export type LoneWorkerViolation = {
  employeeId: string;
  employeeName: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
  shiftIds: string[];
};

export type CoverageGap = {
  dateKey: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
};

export type MealPeriodViolation = {
  shiftId: string;
  employeeId: string | null;
  employeeName: string;
  startsAt: string;
  endsAt: string;
  message: string;
  code: string;
};

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function employeeLabel(shift: ScheduleValidationShift): string {
  return String(shift.employeeName || (shift.employeeId ? "Employee" : "Unassigned shift")).trim() || "Employee";
}

function workSegmentsForShift(shift: ScheduleValidationShift, startMs: number, endMs: number): WorkSegment[] {
  const analysis = analyzeShiftMealCompliance(shift);
  const breaks = [analysis.primaryBreak, analysis.extraBreak]
    .filter((planned): planned is NonNullable<typeof planned> => Boolean(
      planned
      && planned.start.getTime() >= startMs
      && planned.end.getTime() <= endMs
      && planned.end > planned.start,
    ))
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const segments: WorkSegment[] = [];
  let cursor = startMs;
  for (const planned of breaks) {
    const breakStart = Math.max(cursor, planned.start.getTime());
    const breakEnd = Math.min(endMs, planned.end.getTime());
    if (breakStart > cursor) segments.push({ startMs: cursor, endMs: breakStart, shiftId: shift.id });
    cursor = Math.max(cursor, breakEnd);
  }
  if (cursor < endMs) segments.push({ startMs: cursor, endMs, shiftId: shift.id });
  return segments;
}

function normalizedShifts(shifts: ScheduleValidationShift[]): NormalizedShift[] {
  return shifts
    .filter((shift) => shift.status !== "Cancelled")
    .map((shift) => {
      const startMs = new Date(shift.startsAt).getTime();
      const endMs = new Date(shift.endsAt).getTime();
      const meal = analyzeShiftMealCompliance(shift);
      return {
        ...shift,
        startMs,
        endMs,
        hours: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
          ? meal.paidHours
          : 0,
        workSegments: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
          ? workSegmentsForShift(shift, startMs, endMs)
          : [],
      };
    })
    .filter((shift) => shift.endMs > shift.startMs);
}

function coverageGapsForDays(normalized: NormalizedShift[]): CoverageGap[] {
  const byServiceDay = new Map<string, NormalizedShift[]>();
  for (const shift of normalized) {
    const key = newYorkDateKey(shift.startsAt);
    const list = byServiceDay.get(key) || [];
    list.push(shift);
    byServiceDay.set(key, list);
  }

  const gaps: CoverageGap[] = [];
  for (const [dateKey, dayShifts] of byServiceDay) {
    const windowStart = Math.min(...dayShifts.map((shift) => shift.startMs));
    const windowEnd = Math.max(...dayShifts.map((shift) => shift.endMs));
    const coverage = dayShifts
      .filter((shift) => Boolean(shift.employeeId))
      .flatMap((shift) => shift.workSegments)
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

    let cursor = windowStart;
    for (const segment of coverage) {
      if (segment.endMs <= cursor) continue;
      if (segment.startMs > cursor) {
        gaps.push({
          dateKey,
          startsAt: new Date(cursor).toISOString(),
          endsAt: new Date(Math.min(segment.startMs, windowEnd)).toISOString(),
          minutes: Math.round((Math.min(segment.startMs, windowEnd) - cursor) / 60_000),
        });
      }
      cursor = Math.max(cursor, segment.endMs);
      if (cursor >= windowEnd) break;
    }
    if (cursor < windowEnd) {
      gaps.push({
        dateKey,
        startsAt: new Date(cursor).toISOString(),
        endsAt: new Date(windowEnd).toISOString(),
        minutes: Math.round((windowEnd - cursor) / 60_000),
      });
    }
  }

  return gaps.filter((gap) => gap.minutes > 0);
}

export function hourRisk(hours: number): HourRisk {
  if (hours > 40) return "overtime";
  if (hours > 38) return "warning";
  return "normal";
}

export function analyzeSchedule(
  shifts: ScheduleValidationShift[],
  options: { enforceLoneWorker?: boolean } = {},
) {
  const enforceLoneWorker = options.enforceLoneWorker !== false;
  const allowOnDutyMealForSoloShifts = options.enforceLoneWorker === false;
  const normalized = normalizedShifts(shifts);
  const assigned = normalized.filter((shift): shift is NormalizedShift & { employeeId: string } => Boolean(shift.employeeId));
  const employeeHours: Record<string, { employeeId: string; employeeName: string; hours: number; risk: HourRisk }> = {};
  const shiftRisks: Record<string, { cumulativeHours: number; risk: HourRisk }> = {};
  const byEmployee = new Map<string, NormalizedShift[]>();

  for (const shift of assigned) {
    const list = byEmployee.get(shift.employeeId) || [];
    list.push(shift);
    byEmployee.set(shift.employeeId, list);
  }

  const overlaps: ScheduleOverlap[] = [];
  for (const [employeeId, employeeShifts] of byEmployee) {
    employeeShifts.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    let cumulative = 0;
    for (let index = 0; index < employeeShifts.length; index += 1) {
      const shift = employeeShifts[index];
      cumulative += shift.hours;
      shiftRisks[shift.id] = { cumulativeHours: roundHours(cumulative), risk: hourRisk(cumulative) };
      for (let otherIndex = index + 1; otherIndex < employeeShifts.length; otherIndex += 1) {
        const other = employeeShifts[otherIndex];
        if (other.startMs >= shift.endMs) break;
        const overlapStart = Math.max(shift.startMs, other.startMs);
        const overlapEnd = Math.min(shift.endMs, other.endMs);
        if (overlapEnd > overlapStart) {
          overlaps.push({
            employeeId,
            employeeName: employeeLabel(shift),
            firstShiftId: shift.id,
            secondShiftId: other.id,
            startsAt: new Date(overlapStart).toISOString(),
            endsAt: new Date(overlapEnd).toISOString(),
          });
        }
      }
    }
    const first = employeeShifts[0];
    const totalHours = employeeShifts.reduce((total, shift) => total + shift.hours, 0);
    employeeHours[employeeId] = {
      employeeId,
      employeeName: employeeLabel(first),
      hours: roundHours(totalHours),
      risk: hourRisk(totalHours),
    };
  }

  const onDutyMealShiftIds = new Set<string>();
  const mealPeriodViolations: MealPeriodViolation[] = normalized.flatMap((shift) => {
    const analysis = analyzeShiftMealCompliance(shift);
    if (!analysis.issues.length) return [];

    const isSoloAssignedShift = Boolean(
      allowOnDutyMealForSoloShifts
      && shift.employeeId
      && !assigned.some((other) =>
        other.id !== shift.id
        && other.employeeId !== shift.employeeId
        && other.startMs < shift.endMs
        && other.endMs > shift.startMs,
      ),
    );
    if (isSoloAssignedShift) {
      onDutyMealShiftIds.add(shift.id);
      return [];
    }

    return analysis.issues.map((issue) => ({
      shiftId: shift.id,
      employeeId: shift.employeeId,
      employeeName: employeeLabel(shift),
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      message: issue.message,
      code: issue.code,
    }));
  });

  const coverageGaps = coverageGapsForDays(normalized);
  const loneWorkerViolations: LoneWorkerViolation[] = [];
  if (enforceLoneWorker) {
    const segments = assigned.flatMap((shift) => shift.workSegments.map((segment) => ({
      ...segment,
      employeeId: shift.employeeId,
      employeeName: employeeLabel(shift),
    })));
    const boundaries = [...new Set(segments.flatMap((segment) => [segment.startMs, segment.endMs]))].sort((left, right) => left - right);
    const loneSegments: Array<{
      employeeId: string;
      employeeName: string;
      startMs: number;
      endMs: number;
      shiftIds: string[];
    }> = [];

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startMs = boundaries[index];
      const endMs = boundaries[index + 1];
      if (endMs <= startMs) continue;
      const active = segments.filter((segment) => segment.startMs < endMs && segment.endMs > startMs);
      const employees = new Map<string, { name: string; shiftIds: string[] }>();
      for (const segment of active) {
        const current = employees.get(segment.employeeId) || { name: segment.employeeName, shiftIds: [] };
        if (!current.shiftIds.includes(segment.shiftId)) current.shiftIds.push(segment.shiftId);
        employees.set(segment.employeeId, current);
      }
      if (employees.size !== 1) continue;
      const [employeeId, employee] = [...employees.entries()][0];
      const previous = loneSegments[loneSegments.length - 1];
      if (previous && previous.employeeId === employeeId && previous.endMs === startMs) {
        previous.endMs = endMs;
        previous.shiftIds = [...new Set([...previous.shiftIds, ...employee.shiftIds])];
      } else {
        loneSegments.push({ employeeId, employeeName: employee.name, startMs, endMs, shiftIds: employee.shiftIds });
      }
    }

    loneWorkerViolations.push(...loneSegments
      .map((segment) => ({
        employeeId: segment.employeeId,
        employeeName: segment.employeeName,
        startsAt: new Date(segment.startMs).toISOString(),
        endsAt: new Date(segment.endMs).toISOString(),
        minutes: Math.round((segment.endMs - segment.startMs) / 60_000),
        shiftIds: segment.shiftIds,
      }))
      .filter((segment) => segment.minutes > 30));
  }

  const overThirtyEight = Object.values(employeeHours).filter((employee) => employee.hours > 38 && employee.hours <= 40);
  const overForty = Object.values(employeeHours).filter((employee) => employee.hours > 40);
  const blockingIssueCount = overlaps.length
    + loneWorkerViolations.length
    + coverageGaps.length
    + overForty.length
    + mealPeriodViolations.length;

  return {
    employeeHours,
    shiftRisks,
    overlaps,
    loneWorkerViolations,
    coverageGaps,
    mealPeriodViolations,
    onDutyMealShiftIds: [...onDutyMealShiftIds],
    overThirtyEight,
    overForty,
    blockingIssueCount,
    canPublish: blockingIssueCount === 0,
  };
}

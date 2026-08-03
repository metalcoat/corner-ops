export type ScheduleValidationShift = {
  id: string;
  employeeId: string | null;
  employeeName?: string;
  startsAt: string;
  endsAt: string;
  status?: string;
};

export type HourRisk = "normal" | "warning" | "overtime";

type NormalizedShift = ScheduleValidationShift & {
  startMs: number;
  endMs: number;
  hours: number;
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

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function employeeLabel(shift: ScheduleValidationShift): string {
  return String(shift.employeeName || "Employee").trim() || "Employee";
}

function normalizedShifts(shifts: ScheduleValidationShift[]): NormalizedShift[] {
  return shifts
    .filter((shift) => shift.status !== "Cancelled")
    .map((shift) => {
      const startMs = new Date(shift.startsAt).getTime();
      const endMs = new Date(shift.endsAt).getTime();
      return {
        ...shift,
        startMs,
        endMs,
        hours: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
          ? (endMs - startMs) / 3_600_000
          : 0,
      };
    })
    .filter((shift) => shift.hours > 0);
}

export function hourRisk(hours: number): HourRisk {
  if (hours > 40) return "overtime";
  if (hours > 38) return "warning";
  return "normal";
}

export function analyzeSchedule(shifts: ScheduleValidationShift[]) {
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
    employeeHours[employeeId] = {
      employeeId,
      employeeName: employeeLabel(first),
      hours: roundHours(employeeShifts.reduce((total, shift) => total + shift.hours, 0)),
      risk: hourRisk(employeeShifts.reduce((total, shift) => total + shift.hours, 0)),
    };
  }

  const boundaries = [...new Set(assigned.flatMap((shift) => [shift.startMs, shift.endMs]))].sort((left, right) => left - right);
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
    const active = assigned.filter((shift) => shift.startMs < endMs && shift.endMs > startMs);
    const employees = new Map<string, { name: string; shiftIds: string[] }>();
    for (const shift of active) {
      const current = employees.get(shift.employeeId) || { name: employeeLabel(shift), shiftIds: [] };
      if (!current.shiftIds.includes(shift.id)) current.shiftIds.push(shift.id);
      employees.set(shift.employeeId, current);
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

  const loneWorkerViolations: LoneWorkerViolation[] = loneSegments
    .map((segment) => ({
      employeeId: segment.employeeId,
      employeeName: segment.employeeName,
      startsAt: new Date(segment.startMs).toISOString(),
      endsAt: new Date(segment.endMs).toISOString(),
      minutes: Math.round((segment.endMs - segment.startMs) / 60_000),
      shiftIds: segment.shiftIds,
    }))
    .filter((segment) => segment.minutes > 30);

  const overThirtyEight = Object.values(employeeHours).filter((employee) => employee.hours > 38 && employee.hours <= 40);
  const overForty = Object.values(employeeHours).filter((employee) => employee.hours > 40);

  return {
    employeeHours,
    shiftRisks,
    overlaps,
    loneWorkerViolations,
    overThirtyEight,
    overForty,
    blockingIssueCount: overlaps.length + loneWorkerViolations.length + overForty.length,
    canPublish: overlaps.length === 0 && loneWorkerViolations.length === 0 && overForty.length === 0,
  };
}

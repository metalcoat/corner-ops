// Scheduled vs worked hours for the payroll summary (the payroll page, the Monday
// approval email and the payroll CSV). Pure: the caller loads the week's published
// schedule shifts and punches. No imports, only erasable type syntax.
//
// Matching: a schedule shift belongs to the employee on it (schedule_shifts.employee_id,
// named from employees.name). A punch counts for that employee when both carry the same
// employee id (Tiki time_entries), otherwise when the names match ignoring case and
// spacing (Corner Deli's Rezku punches only have a name). Payroll rows are matched to
// schedule shifts by name the same way.

export type ScheduleShiftInput = { employeeId?: string | null; employeeName: string; startsAt: string | Date; endsAt: string | Date };
export type PunchInput = { employeeId?: string | null; employeeName: string; clockIn: string | Date | null; clockOut: string | Date | null };
export type WorkedRowInput = {
  employee: string;
  hours?: number;
  regularHours?: number;
  overtimeHours?: number;
  driverTipHours?: number;
  tips?: number;
};

export type ScheduleComparison = {
  employee: string;
  scheduledHours: number;
  workedHours: number;
  /** worked − scheduled. */
  difference: number;
  scheduledShifts: number;
  /** Scheduled shifts (already started) with no punch of that employee anywhere near them. */
  missedShifts: number;
  flagged: boolean;
  text: string;
};

/** A difference of at least this many hours is flagged. */
export const DISCREPANCY_FLAG_HOURS = 1;
/** A punch this close before or after a shift still counts as working it (early starts, late swaps). */
export const SHIFT_MATCH_GRACE_MINUTES = 60;

function nameKey(name: string): string {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function time(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function signedHours(value: number): string {
  const rounded = round2(value);
  if (!rounded) return "0.00";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(2)}`;
}

export function discrepancyText(c: { scheduledHours: number; workedHours: number; difference: number; scheduledShifts: number; missedShifts: number }): string {
  const parts = c.scheduledShifts
    ? [`Scheduled ${c.scheduledHours.toFixed(2)}`, `worked ${c.workedHours.toFixed(2)}`, signedHours(c.difference)]
    : [`Not scheduled`, `worked ${c.workedHours.toFixed(2)}`];
  if (c.missedShifts) parts.push(`${c.missedShifts} missed shift${c.missedShifts === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * One line per employee who worked or was scheduled: scheduled hours (published shifts in the week), worked
 * hours (the payroll row's clocked hours) and missed shifts. Flagged when |worked − scheduled| ≥ 1 hour or a
 * started shift has no punch at all.
 */
export function compareScheduleToWorked(input: {
  rows: WorkedRowInput[];
  shifts: ScheduleShiftInput[];
  punches: PunchInput[];
  now?: Date;
  graceMinutes?: number;
}): ScheduleComparison[] {
  const now = (input.now || new Date()).getTime();
  const grace = (input.graceMinutes ?? SHIFT_MATCH_GRACE_MINUTES) * 60_000;
  const people = new Map<string, { employee: string; ids: Set<string>; worked: number; scheduled: number; shifts: number; missed: number }>();
  const person = (name: string) => {
    const key = nameKey(name);
    let entry = people.get(key);
    if (!entry) {
      entry = { employee: String(name).trim(), ids: new Set(), worked: 0, scheduled: 0, shifts: 0, missed: 0 };
      people.set(key, entry);
    }
    return entry;
  };
  for (const row of input.rows) {
    if (!String(row.employee || "").trim() || /^(unallocated|cover)$/i.test(String(row.employee).trim())) continue;
    person(row.employee).worked += Number(row.hours || 0);
  }

  const punches = input.punches.map((p) => {
    const start = time(p.clockIn) ?? time(p.clockOut);
    const end = time(p.clockOut) ?? start;
    return { id: p.employeeId ? String(p.employeeId) : "", key: nameKey(p.employeeName), start, end };
  }).filter((p) => p.start !== null && p.end !== null) as Array<{ id: string; key: string; start: number; end: number }>;

  for (const shift of input.shifts) {
    const name = String(shift.employeeName || "").trim();
    const start = time(shift.startsAt), end = time(shift.endsAt);
    if (!name || start === null || end === null || end <= start) continue;
    const entry = person(name);
    const id = shift.employeeId ? String(shift.employeeId) : "";
    if (id) entry.ids.add(id);
    entry.scheduled += (end - start) / 3_600_000;
    entry.shifts += 1;
    if (start > now) continue;
    const key = nameKey(name);
    const worked = punches.some((p) => (id && p.id ? p.id === id : p.key === key) && p.start < end + grace && p.end > start - grace);
    if (!worked) entry.missed += 1;
  }

  return [...people.values()].map((entry) => {
    const scheduledHours = round2(entry.scheduled);
    const workedHours = round2(entry.worked);
    const difference = round2(workedHours - scheduledHours);
    const base = { employee: entry.employee, scheduledHours, workedHours, difference, scheduledShifts: entry.shifts, missedShifts: entry.missed };
    return { ...base, flagged: Math.abs(difference) >= DISCREPANCY_FLAG_HOURS || entry.missed > 0, text: discrepancyText(base) };
  }).sort((a, b) => a.employee.localeCompare(b.employee));
}

export type PayrollDisplayRow = {
  employee: string;
  regularHours: number;
  /** Tipped (driver) hours: Payroll Relief's TipWa. */
  tippedHours: number;
  /** All tips, manual ones included. */
  tips: number;
  overtimeHours: number;
  schedule: ScheduleComparison | null;
};

/** The payroll rows plus anyone who was scheduled but has no hours, sorted by name. */
export function payrollDisplayRows(rows: WorkedRowInput[], comparisons: ScheduleComparison[]): PayrollDisplayRow[] {
  const byKey = new Map(comparisons.map((c) => [nameKey(c.employee), c]));
  const out: PayrollDisplayRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = nameKey(row.employee);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      employee: String(row.employee).trim(),
      regularHours: round2(Number(row.regularHours || 0)),
      tippedHours: round2(Number(row.driverTipHours || 0)),
      tips: round2(Number(row.tips || 0)),
      overtimeHours: round2(Number(row.overtimeHours || 0)),
      schedule: byKey.get(key) || null,
    });
  }
  for (const c of comparisons) {
    const key = nameKey(c.employee);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ employee: c.employee, regularHours: 0, tippedHours: 0, tips: 0, overtimeHours: 0, schedule: c });
  }
  return out.sort((a, b) => a.employee.localeCompare(b.employee));
}

/** The OT column is shown only when someone has overtime that week. */
export function showOvertimeColumn(rows: Array<{ overtimeHours?: number }>): boolean {
  return rows.some((row) => Number(row.overtimeHours || 0) > 0);
}

/** Header and cells for the payroll CSV download. */
export function payrollDisplayCsvRows(rows: PayrollDisplayRow[]): string[][] {
  const overtime = showOvertimeColumn(rows);
  const header = ["Employee", "Regular Hours", "Tipped Hours", "Tips", ...(overtime ? ["Overtime Hours"] : []),
    "Scheduled Hours", "Worked Hours", "Difference (worked - scheduled)", "Missed Shifts", "Scheduled vs Worked", "Flag"];
  const lines = [header];
  for (const row of rows) {
    const s = row.schedule;
    lines.push([
      row.employee, row.regularHours.toFixed(2), row.tippedHours.toFixed(2), row.tips.toFixed(2),
      ...(overtime ? [row.overtimeHours.toFixed(2)] : []),
      (s?.scheduledHours ?? 0).toFixed(2), (s?.workedHours ?? 0).toFixed(2), signedHours(s?.difference ?? 0),
      // Plain ASCII separators: spreadsheets opening the CSV may not read it as UTF-8.
      String(s?.missedShifts ?? 0), (s?.text || "").replace(/ · /g, "; "), s?.flagged ? "Check" : "",
    ]);
  }
  return lines;
}

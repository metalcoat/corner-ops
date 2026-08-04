import { createHash } from "node:crypto";
import { analyzeShiftMealCompliance } from "@/lib/schedule-meal-compliance";
import { ensureSchema, getSql } from "@/lib/db";
import { createOperationIssue, ensureIntegrationSchema } from "@/lib/integrations";
import { notifyOwnersOfOperationalAlert } from "@/lib/owner-operational-alerts";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const WORKWEEK_START_HOUR = 4;
const WARNING_HOURS = 38;
const OVERTIME_HOURS = 40;
const MAX_OPEN_SHIFT_HOURS = 18;
let overtimeSchemaPromise: Promise<void> | null = null;

type EmployeeRow = {
  id: string;
  name: string;
  position: string;
  role_group: string;
  active: boolean;
};

type ScheduleRow = {
  id: string;
  employee_id: string | null;
  employee_name: string | null;
  position: string;
  starts_at: string;
  ends_at: string;
  meal_break_start: string | null;
  meal_break_minutes: number;
  extra_meal_break_start: string | null;
  extra_meal_break_minutes: number;
  status: string;
};

type ActualRow = {
  id: string;
  employee_id: string | null;
  employee_name: string;
  position: string;
  clock_in: string | null;
  clock_out: string | null;
  reported_hours: number | string | null;
};

type AvailabilityRow = {
  employee_id: string;
  weekday: number;
  available: boolean;
  available_from: string;
  available_to: string;
};

type TimeOffRow = {
  employee_id: string;
  starts_on: string;
  ends_on: string;
};

type RiskLevel = "normal" | "warning" | "overtime";

type ActualEntry = {
  id: string;
  employeeId: string | null;
  employeeName: string;
  position: string;
  clockIn: string | null;
  clockOut: string | null;
  hours: number;
};

type ScheduledShift = {
  id: string;
  employeeId: string | null;
  employeeName: string;
  position: string;
  startsAt: string;
  endsAt: string;
  mealBreakStart: string | null;
  mealBreakMinutes: number;
  extraMealBreakStart: string | null;
  extraMealBreakMinutes: number;
  status: string;
  paidHours: number;
};

export type OvertimeReplacementSuggestion = {
  employeeId: string;
  employeeName: string;
  position: string;
  projectedHours: number;
  projectedAfterShift: number;
  availability: "Available" | "Not set";
  reason: string;
};

export type OvertimeRiskItem = {
  employeeId: string;
  employeeName: string;
  position: string;
  risk: RiskLevel;
  actualHours: number;
  remainingScheduledHours: number;
  projectedHours: number;
  plannedHours: number;
  unplannedHours: number;
  warningShift: ScheduledShift | null;
  overtimeShift: ScheduledShift | null;
  replacementShift: ScheduledShift | null;
  replacements: OvertimeReplacementSuggestion[];
};

export type ShiftCoverageMismatch = {
  actualEntryId: string;
  actualEmployeeId: string | null;
  actualEmployeeName: string;
  scheduledEmployeeId: string | null;
  scheduledEmployeeName: string;
  scheduledShiftId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  hours: number;
  kind: "Unscheduled" | "Covered another employee" | "Unmapped employee";
  detail: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function roundHours(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function dateKey(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function localDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const text = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return {
    year: Number(text("year")),
    month: Number(text("month")),
    day: Number(text("day")),
    weekday: text("weekday"),
    hour: Number(text("hour")),
  };
}

function localDateString(value: Date | string): string {
  const parts = localDateParts(value instanceof Date ? value : new Date(value));
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
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
    timestamp = Date.UTC(year, month - 1, day, hour, 0, 0)
      - getOffsetMilliseconds(new Date(timestamp), TIME_ZONE);
  }
  return new Date(timestamp);
}

export function currentOvertimeWeekStart(value = new Date()): string {
  const local = localDateParts(value);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day, 12));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(local.weekday);
  const daysSinceMonday = (Math.max(0, weekday) + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  if (daysSinceMonday === 0 && local.hour < WORKWEEK_START_HOUR) date.setUTCDate(date.getUTCDate() - 7);
  return dateKey(date);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function workweekBounds(requestedWeekStart?: string) {
  const weekStart = requestedWeekStart && /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekStart)
    ? requestedWeekStart
    : currentOvertimeWeekStart();
  const start = zonedDateToUtc(weekStart, WORKWEEK_START_HOUR);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { weekStart, start, end };
}

function riskLevel(hours: number): RiskLevel {
  if (hours > OVERTIME_HOURS) return "overtime";
  if (hours >= WARNING_HOURS) return "warning";
  return "normal";
}

function actualHours(row: ActualRow, weekStartMs: number, weekEndMs: number): number {
  const reported = Number(row.reported_hours || 0);
  if (!row.clock_in) return reported > 0 ? roundHours(reported) : 0;

  const fullStart = new Date(row.clock_in).getTime();
  const fullEnd = row.clock_out ? new Date(row.clock_out).getTime() : Date.now();
  if (!Number.isFinite(fullStart) || !Number.isFinite(fullEnd) || fullEnd <= fullStart) return 0;

  const overlapStart = Math.max(fullStart, weekStartMs);
  const overlapEnd = Math.min(fullEnd, weekEndMs);
  if (overlapEnd <= overlapStart) return 0;

  const fullDuration = fullEnd - fullStart;
  const overlapDuration = overlapEnd - overlapStart;
  if (reported > 0 && row.clock_out && fullDuration > 0) {
    return roundHours(reported * (overlapDuration / fullDuration));
  }
  return roundHours(Math.min(MAX_OPEN_SHIFT_HOURS, overlapDuration / 3_600_000));
}

function shiftFor(row: ScheduleRow): ScheduledShift {
  const shift = {
    id: String(row.id),
    employeeId: row.employee_id ? String(row.employee_id) : null,
    employeeName: clean(row.employee_name, 120),
    position: clean(row.position, 100),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    mealBreakStart: row.meal_break_start ? String(row.meal_break_start) : null,
    mealBreakMinutes: Number(row.meal_break_minutes || 0),
    extraMealBreakStart: row.extra_meal_break_start ? String(row.extra_meal_break_start) : null,
    extraMealBreakMinutes: Number(row.extra_meal_break_minutes || 0),
    status: clean(row.status, 30),
  };
  return { ...shift, paidHours: analyzeShiftMealCompliance(shift).paidHours };
}

function remainingPaidHours(shift: ScheduledShift, nowMs: number): number {
  const shiftStart = new Date(shift.startsAt).getTime();
  const shiftEnd = new Date(shift.endsAt).getTime();
  if (!Number.isFinite(shiftStart) || !Number.isFinite(shiftEnd) || shiftEnd <= nowMs) return 0;
  if (shiftStart >= nowMs) return shift.paidHours;

  let remainingMs = shiftEnd - nowMs;
  for (const planned of [
    shift.mealBreakStart && shift.mealBreakMinutes
      ? { start: new Date(shift.mealBreakStart).getTime(), minutes: shift.mealBreakMinutes }
      : null,
    shift.extraMealBreakStart && shift.extraMealBreakMinutes
      ? { start: new Date(shift.extraMealBreakStart).getTime(), minutes: shift.extraMealBreakMinutes }
      : null,
  ]) {
    if (!planned || !Number.isFinite(planned.start)) continue;
    const breakEnd = planned.start + planned.minutes * 60_000;
    const overlap = Math.max(0, Math.min(shiftEnd, breakEnd) - Math.max(nowMs, planned.start));
    remainingMs -= overlap;
  }
  return roundHours(Math.max(0, remainingMs / 3_600_000));
}

function overlapHours(actual: ActualEntry, shift: ScheduledShift): number {
  if (!actual.clockIn) return 0;
  const actualStart = new Date(actual.clockIn).getTime();
  const actualEnd = actual.clockOut ? new Date(actual.clockOut).getTime() : Date.now();
  const shiftStart = new Date(shift.startsAt).getTime();
  const shiftEnd = new Date(shift.endsAt).getTime();
  const overlap = Math.min(actualEnd, shiftEnd) - Math.max(actualStart, shiftStart);
  return overlap > 0 ? overlap / 3_600_000 : 0;
}

function localWeekdayAndMinutes(value: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const weekdayText = parts.find((item) => item.type === "weekday")?.value || "Sun";
  const hour = Number(parts.find((item) => item.type === "hour")?.value || 0);
  const minute = Number(parts.find((item) => item.type === "minute")?.value || 0);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayText);
  return { weekday: Math.max(0, weekday), minutes: hour * 60 + minute };
}

function timeMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value || "");
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function availabilityForShift(
  rows: AvailabilityRow[],
  employeeId: string,
  shift: ScheduledShift,
): "Available" | "Not set" | "Unavailable" {
  const start = localWeekdayAndMinutes(shift.startsAt);
  const end = localWeekdayAndMinutes(shift.endsAt);
  const row = rows.find((item) => item.employee_id === employeeId && Number(item.weekday) === start.weekday);
  if (!row) return "Not set";
  if (!row.available) return "Unavailable";
  const availableFrom = timeMinutes(row.available_from);
  const availableTo = timeMinutes(row.available_to);
  if (availableFrom === null || availableTo === null) return "Available";
  const shiftEnd = end.weekday === start.weekday ? end.minutes : end.minutes + 1440;
  const rangeEnd = availableTo >= availableFrom ? availableTo : availableTo + 1440;
  return start.minutes >= availableFrom && shiftEnd <= rangeEnd ? "Available" : "Unavailable";
}

function overlappingShift(shifts: ScheduledShift[], employeeId: string, target: ScheduledShift): boolean {
  const start = new Date(target.startsAt).getTime();
  const end = new Date(target.endsAt).getTime();
  return shifts.some((shift) => shift.employeeId === employeeId
    && shift.id !== target.id
    && shift.status !== "Cancelled"
    && new Date(shift.startsAt).getTime() < end
    && new Date(shift.endsAt).getTime() > start);
}

function onApprovedTimeOff(rows: TimeOffRow[], employeeId: string, target: ScheduledShift): boolean {
  const date = localDateString(target.startsAt);
  return rows.some((row) => row.employee_id === employeeId && row.starts_on <= date && row.ends_on >= date);
}

export async function ensureOvertimeRiskSchema(): Promise<void> {
  if (!overtimeSchemaPromise) {
    overtimeSchemaPromise = (async () => {
      await ensureSchema();
      await ensureIntegrationSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS shift_change_log (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          shift_id UUID REFERENCES schedule_shifts(id) ON DELETE SET NULL,
          change_type TEXT NOT NULL,
          prior_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
          prior_employee_name TEXT NOT NULL DEFAULT '',
          new_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
          new_employee_name TEXT NOT NULL DEFAULT '',
          starts_at TIMESTAMPTZ,
          ends_at TIMESTAMPTZ,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS shift_change_log_business_created_idx ON shift_change_log (business, created_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS overtime_risk_alerts (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          week_start DATE NOT NULL,
          risk_level TEXT NOT NULL CHECK (risk_level IN ('warning', 'overtime')),
          signature TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved')),
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_notified_at TIMESTAMPTZ,
          resolved_at TIMESTAMPTZ,
          UNIQUE (business, employee_id, week_start)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS overtime_risk_alerts_open_idx ON overtime_risk_alerts (business, status, week_start)`;
      await sql`
        CREATE OR REPLACE FUNCTION corner_ops_log_schedule_shift_change()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
          old_name TEXT := '';
          new_name TEXT := '';
          kind TEXT := '';
          prior_employee UUID := NULL;
          prior_start TIMESTAMPTZ := NULL;
          prior_end TIMESTAMPTZ := NULL;
          prior_status TEXT := NULL;
        BEGIN
          IF TG_OP = 'UPDATE' THEN
            IF OLD.employee_id IS NOT DISTINCT FROM NEW.employee_id
               AND OLD.starts_at IS NOT DISTINCT FROM NEW.starts_at
               AND OLD.ends_at IS NOT DISTINCT FROM NEW.ends_at
               AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
              RETURN NEW;
            END IF;
            prior_employee := OLD.employee_id;
            prior_start := OLD.starts_at;
            prior_end := OLD.ends_at;
            prior_status := OLD.status;
          END IF;

          IF TG_OP = 'INSERT' THEN
            kind := CASE WHEN NEW.employee_id IS NULL THEN 'Created open shift' ELSE 'Created assignment' END;
          ELSIF prior_employee IS DISTINCT FROM NEW.employee_id THEN
            kind := CASE
              WHEN prior_employee IS NULL THEN 'Assigned open shift'
              WHEN NEW.employee_id IS NULL THEN 'Unassigned shift'
              ELSE 'Reassigned shift'
            END;
          ELSIF prior_start IS DISTINCT FROM NEW.starts_at OR prior_end IS DISTINCT FROM NEW.ends_at THEN
            kind := 'Changed shift time';
          ELSE
            kind := 'Changed shift status';
          END IF;

          IF prior_employee IS NOT NULL THEN
            SELECT name INTO old_name FROM employees WHERE id = prior_employee;
          END IF;
          IF NEW.employee_id IS NOT NULL THEN
            SELECT name INTO new_name FROM employees WHERE id = NEW.employee_id;
          END IF;

          INSERT INTO shift_change_log (
            id, business, shift_id, change_type, prior_employee_id, prior_employee_name,
            new_employee_id, new_employee_name, starts_at, ends_at, details
          ) VALUES (
            gen_random_uuid(), NEW.business, NEW.id, kind,
            prior_employee, COALESCE(old_name, ''), NEW.employee_id, COALESCE(new_name, ''),
            NEW.starts_at, NEW.ends_at,
            jsonb_build_object(
              'priorStartsAt', prior_start,
              'priorEndsAt', prior_end,
              'priorStatus', prior_status,
              'newStatus', NEW.status,
              'position', NEW.position
            )
          );
          RETURN NEW;
        END;
        $$;
      `;
      await sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'corner_ops_schedule_shift_change' AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER corner_ops_schedule_shift_change
            AFTER INSERT OR UPDATE OF employee_id, starts_at, ends_at, status ON schedule_shifts
            FOR EACH ROW EXECUTE FUNCTION corner_ops_log_schedule_shift_change();
          END IF;
        END;
        $$;
      `;
    })().catch((error) => {
      overtimeSchemaPromise = null;
      throw error;
    });
  }
  return overtimeSchemaPromise;
}

async function actualRows(
  business: Business,
  weekStartIso: string,
  weekEndIso: string,
): Promise<ActualRow[]> {
  if (business === "Tiki") {
    return await getSql()`
      SELECT t.id, t.employee_id, COALESCE(e.name, t.employee_name, '') AS employee_name,
        COALESCE(t.position, '') AS position, t.clock_in, t.clock_out, NULL::numeric AS reported_hours
      FROM time_entries t
      LEFT JOIN employees e ON e.id = t.employee_id
      WHERE t.business = 'Tiki'
        AND t.clock_in < ${weekEndIso}
        AND COALESCE(t.clock_out, NOW()) > ${weekStartIso}
      ORDER BY t.clock_in
    ` as unknown as ActualRow[];
  }

  return await getSql()`
    SELECT r.id, e.id AS employee_id, r.employee_name, COALESCE(r.position, '') AS position,
      r.clock_in, r.clock_out, r.reported_hours
    FROM rezku_shifts r
    LEFT JOIN employees e
      ON e.business = 'Corner Deli'
     AND LOWER(BTRIM(e.name)) = LOWER(BTRIM(r.employee_name))
    WHERE COALESCE(r.clock_in, r.clock_out) < ${weekEndIso}
      AND COALESCE(r.clock_out, r.clock_in) > ${weekStartIso}
    ORDER BY COALESCE(r.clock_in, r.clock_out)
  ` as unknown as ActualRow[];
}

export async function overtimeRiskDashboard(business: Business, requestedWeekStart?: string) {
  await ensureOvertimeRiskSchema();
  const bounds = workweekBounds(requestedWeekStart);
  const weekStart = bounds.weekStart;
  const weekEndDate = addDays(weekStart, 7);
  const weekStartIso = bounds.start.toISOString();
  const weekEndIso = bounds.end.toISOString();
  const sql = getSql();

  const [employeeRows, scheduleRows, availabilityRows, timeOffRows, actualSourceRows, changeRows] = await Promise.all([
    sql`
      SELECT id, name, position, role_group, active
      FROM employees
      WHERE business = ${business} AND active = TRUE
      ORDER BY name
    ` as unknown as EmployeeRow[],
    sql`
      SELECT s.id, s.employee_id, e.name AS employee_name, s.position, s.starts_at, s.ends_at,
        s.meal_break_start, s.meal_break_minutes, s.extra_meal_break_start, s.extra_meal_break_minutes, s.status
      FROM schedule_shifts s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.business = ${business}
        AND s.starts_at >= ${weekStartIso}
        AND s.starts_at < ${weekEndIso}
        AND s.status <> 'Cancelled'
      ORDER BY s.starts_at
    ` as unknown as ScheduleRow[],
    sql`
      SELECT employee_id, weekday, available, available_from, available_to
      FROM employee_availability
      WHERE business = ${business}
    ` as unknown as AvailabilityRow[],
    sql`
      SELECT employee_id, starts_on::text, ends_on::text
      FROM time_off_requests
      WHERE business = ${business} AND status = 'Approved'
        AND starts_on < ${weekEndDate}::date AND ends_on >= ${weekStart}::date
    ` as unknown as TimeOffRow[],
    actualRows(business, weekStartIso, weekEndIso),
    sql`
      SELECT id, shift_id, change_type, prior_employee_id, prior_employee_name,
        new_employee_id, new_employee_name, starts_at, ends_at, details, created_at
      FROM shift_change_log
      WHERE business = ${business}
        AND created_at >= ${weekStartIso}
        AND created_at < ${weekEndIso}
      ORDER BY created_at DESC
      LIMIT 100
    ` as unknown as Array<Record<string, unknown>>,
  ]);

  const employees = employeeRows.map((row) => ({
    id: String(row.id),
    name: clean(row.name, 120),
    position: clean(row.position, 100),
    roleGroup: clean(row.role_group, 30),
  }));
  const shifts = scheduleRows.map(shiftFor);
  const actual = actualSourceRows.map((row): ActualEntry => ({
    id: String(row.id),
    employeeId: row.employee_id ? String(row.employee_id) : null,
    employeeName: clean(row.employee_name, 120) || "Unknown employee",
    position: clean(row.position, 100),
    clockIn: row.clock_in ? String(row.clock_in) : null,
    clockOut: row.clock_out ? String(row.clock_out) : null,
    hours: actualHours(row, bounds.start.getTime(), bounds.end.getTime()),
  })).filter((entry) => entry.hours > 0);

  const mismatches: ShiftCoverageMismatch[] = actual.flatMap((entry) => {
    if (!entry.employeeId) {
      return [{
        actualEntryId: entry.id,
        actualEmployeeId: null,
        actualEmployeeName: entry.employeeName,
        scheduledEmployeeId: null,
        scheduledEmployeeName: "",
        scheduledShiftId: null,
        startsAt: entry.clockIn,
        endsAt: entry.clockOut,
        hours: entry.hours,
        kind: "Unmapped employee" as const,
        detail: `${entry.employeeName} does not match an active ${business} employee record.`,
      }];
    }

    const candidates = shifts
      .map((shift) => ({ shift, overlap: overlapHours(entry, shift) }))
      .filter((candidate) => candidate.overlap >= 0.5)
      .sort((left, right) => right.overlap - left.overlap);
    const matched = candidates[0]?.shift || null;

    if (!matched) {
      return [{
        actualEntryId: entry.id,
        actualEmployeeId: entry.employeeId,
        actualEmployeeName: entry.employeeName,
        scheduledEmployeeId: null,
        scheduledEmployeeName: "",
        scheduledShiftId: null,
        startsAt: entry.clockIn,
        endsAt: entry.clockOut,
        hours: entry.hours,
        kind: "Unscheduled" as const,
        detail: `${entry.employeeName} worked ${entry.hours.toFixed(1)} hours without an overlapping scheduled assignment.`,
      }];
    }

    if (!matched.employeeId) {
      return [{
        actualEntryId: entry.id,
        actualEmployeeId: entry.employeeId,
        actualEmployeeName: entry.employeeName,
        scheduledEmployeeId: null,
        scheduledEmployeeName: "Open shift",
        scheduledShiftId: matched.id,
        startsAt: entry.clockIn,
        endsAt: entry.clockOut,
        hours: entry.hours,
        kind: "Unscheduled" as const,
        detail: `${entry.employeeName} worked an open or unassigned scheduled shift.`,
      }];
    }

    if (matched.employeeId !== entry.employeeId) {
      return [{
        actualEntryId: entry.id,
        actualEmployeeId: entry.employeeId,
        actualEmployeeName: entry.employeeName,
        scheduledEmployeeId: matched.employeeId,
        scheduledEmployeeName: matched.employeeName,
        scheduledShiftId: matched.id,
        startsAt: entry.clockIn,
        endsAt: entry.clockOut,
        hours: entry.hours,
        kind: "Covered another employee" as const,
        detail: `${entry.employeeName} appears to have worked ${matched.employeeName || "another employee"}'s scheduled shift.`,
      }];
    }
    return [];
  });

  const actualByEmployee = new Map<string, number>();
  for (const entry of actual) {
    if (!entry.employeeId) continue;
    actualByEmployee.set(entry.employeeId, roundHours((actualByEmployee.get(entry.employeeId) || 0) + entry.hours));
  }

  const unplannedByEmployee = new Map<string, number>();
  for (const mismatch of mismatches) {
    if (!mismatch.actualEmployeeId) continue;
    unplannedByEmployee.set(
      mismatch.actualEmployeeId,
      roundHours((unplannedByEmployee.get(mismatch.actualEmployeeId) || 0) + mismatch.hours),
    );
  }

  const nowMs = Date.now();
  const base = employees.map((employee) => {
    const employeeShifts = shifts.filter((shift) => shift.employeeId === employee.id);
    const remaining = employeeShifts
      .map((shift) => ({ shift, hours: remainingPaidHours(shift, nowMs) }))
      .filter((item) => item.hours > 0)
      .sort((left, right) => left.shift.startsAt.localeCompare(right.shift.startsAt));
    const actualValue = roundHours(actualByEmployee.get(employee.id) || 0);
    const remainingValue = roundHours(remaining.reduce((total, item) => total + item.hours, 0));
    const planned = roundHours(employeeShifts.reduce((total, shift) => total + shift.paidHours, 0));
    let cumulative = actualValue;
    let warningShift: ScheduledShift | null = null;
    let overtimeShift: ScheduledShift | null = null;
    for (const item of remaining) {
      cumulative += item.hours;
      if (!warningShift && cumulative >= WARNING_HOURS) warningShift = item.shift;
      if (!overtimeShift && cumulative > OVERTIME_HOURS) overtimeShift = item.shift;
    }
    const projected = roundHours(actualValue + remainingValue);
    return {
      employee,
      actualHours: actualValue,
      remainingScheduledHours: remainingValue,
      projectedHours: projected,
      plannedHours: planned,
      unplannedHours: roundHours(unplannedByEmployee.get(employee.id) || 0),
      warningShift,
      overtimeShift,
      replacementShift: overtimeShift || warningShift || remaining[0]?.shift || null,
      risk: riskLevel(projected),
    };
  });
  const baseById = new Map(base.map((item) => [item.employee.id, item]));

  const risks: OvertimeRiskItem[] = base.map((item) => {
    const target = item.replacementShift;
    const replacements: OvertimeReplacementSuggestion[] = !target ? [] : employees
      .filter((candidate) => candidate.id !== item.employee.id)
      .map((candidate) => {
        const candidateBase = baseById.get(candidate.id);
        if (!candidateBase) return null;
        if (overlappingShift(shifts, candidate.id, target)) return null;
        if (onApprovedTimeOff(timeOffRows, candidate.id, target)) return null;
        const availability = availabilityForShift(availabilityRows, candidate.id, target);
        if (availability === "Unavailable") return null;
        const exactPosition = candidate.position.toLowerCase() === target.position.toLowerCase();
        const sameRole = Boolean(candidate.roleGroup && candidate.roleGroup === item.employee.roleGroup);
        if (!exactPosition && !sameRole) return null;
        const projectedAfterShift = roundHours(candidateBase.projectedHours + target.paidHours);
        if (projectedAfterShift > OVERTIME_HOURS) return null;
        const score = (exactPosition ? 100 : 0)
          + (sameRole ? 40 : 0)
          + (availability === "Available" ? 15 : 0)
          + Math.max(0, 40 - projectedAfterShift);
        return {
          employeeId: candidate.id,
          employeeName: candidate.name,
          position: candidate.position,
          projectedHours: candidateBase.projectedHours,
          projectedAfterShift,
          availability,
          reason: exactPosition
            ? `Same position; projected at ${projectedAfterShift.toFixed(1)} hours after the shift.`
            : `Same role group; projected at ${projectedAfterShift.toFixed(1)} hours after the shift.`,
          score,
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .sort((left, right) => right.score - left.score || left.projectedAfterShift - right.projectedAfterShift)
      .slice(0, 3)
      .map(({ score: _score, ...candidate }) => candidate);

    return {
      employeeId: item.employee.id,
      employeeName: item.employee.name,
      position: item.employee.position,
      risk: item.risk,
      actualHours: item.actualHours,
      remainingScheduledHours: item.remainingScheduledHours,
      projectedHours: item.projectedHours,
      plannedHours: item.plannedHours,
      unplannedHours: item.unplannedHours,
      warningShift: item.warningShift,
      overtimeShift: item.overtimeShift,
      replacementShift: item.replacementShift,
      replacements,
    };
  }).sort((left, right) => {
    const rank: Record<RiskLevel, number> = { overtime: 2, warning: 1, normal: 0 };
    return rank[right.risk] - rank[left.risk] || right.projectedHours - left.projectedHours;
  });

  return {
    business,
    weekStart,
    weekEnd: addDays(weekStart, 6),
    generatedAt: new Date().toISOString(),
    thresholds: { warning: WARNING_HOURS, overtime: OVERTIME_HOURS },
    summary: {
      activeEmployees: employees.length,
      warning: risks.filter((item) => item.risk === "warning").length,
      overtime: risks.filter((item) => item.risk === "overtime").length,
      coverageMismatches: mismatches.length,
    },
    risks,
    coverageMismatches: mismatches.sort(
      (left, right) => String(right.startsAt || "").localeCompare(String(left.startsAt || "")),
    ),
    shiftChanges: changeRows.map((row) => ({
      id: String(row.id),
      shiftId: row.shift_id ? String(row.shift_id) : null,
      changeType: clean(row.change_type, 80),
      priorEmployeeId: row.prior_employee_id ? String(row.prior_employee_id) : null,
      priorEmployeeName: clean(row.prior_employee_name, 120),
      newEmployeeId: row.new_employee_id ? String(row.new_employee_id) : null,
      newEmployeeName: clean(row.new_employee_name, 120),
      startsAt: row.starts_at ? String(row.starts_at) : null,
      endsAt: row.ends_at ? String(row.ends_at) : null,
      details: row.details || {},
      createdAt: String(row.created_at),
    })),
  };
}

export async function evaluateAndNotifyOvertimeRisk(input: {
  business: Business;
  source?: string;
  notify?: boolean;
}) {
  const dashboard = await overtimeRiskDashboard(input.business);
  const activeRisks = dashboard.risks.filter((item) => item.risk !== "normal");
  const sql = getSql();
  const notified: Array<{ employeeId: string; delivered: number; failed: number; emailSent: boolean }> = [];

  for (const risk of activeRisks) {
    const signature = createHash("sha256").update(JSON.stringify({
      risk: risk.risk,
      actual: risk.actualHours,
      remaining: risk.remainingScheduledHours,
      projected: risk.projectedHours,
      trigger: risk.replacementShift?.id || "",
      mismatches: dashboard.coverageMismatches
        .filter((item) => item.actualEmployeeId === risk.employeeId)
        .map((item) => item.actualEntryId),
      replacements: risk.replacements.map((item) => item.employeeId),
    })).digest("hex");
    const previous = await sql`
      SELECT signature, last_notified_at
      FROM overtime_risk_alerts
      WHERE business = ${input.business}
        AND employee_id = ${risk.employeeId}
        AND week_start = ${dashboard.weekStart}
      LIMIT 1
    ` as unknown as Array<{ signature: string; last_notified_at: string | null }>;
    const lastNotified = previous[0]?.last_notified_at ? new Date(previous[0].last_notified_at).getTime() : 0;
    const shouldNotify = input.notify !== false
      && (previous[0]?.signature !== signature || !lastNotified || Date.now() - lastNotified >= 24 * 60 * 60 * 1000);

    const storedRiskLevel = risk.risk === "overtime" ? "overtime" : "warning";
    await sql`
      INSERT INTO overtime_risk_alerts (
        id, business, employee_id, week_start, risk_level, signature, details, status,
        first_seen_at, last_seen_at, last_notified_at, resolved_at
      ) VALUES (
        ${crypto.randomUUID()}, ${input.business}, ${risk.employeeId}, ${dashboard.weekStart},
        ${storedRiskLevel}, ${signature}, ${JSON.stringify(risk)}::jsonb, 'Open', NOW(), NOW(), NULL, NULL
      )
      ON CONFLICT (business, employee_id, week_start) DO UPDATE SET
        risk_level = EXCLUDED.risk_level,
        signature = EXCLUDED.signature,
        details = EXCLUDED.details,
        status = 'Open',
        last_seen_at = NOW(),
        resolved_at = NULL
    `;

    const trigger = risk.replacementShift
      ? `${new Intl.DateTimeFormat("en-US", {
          timeZone: TIME_ZONE,
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(risk.replacementShift.startsAt))} shift`
      : "remaining schedule";
    const suggestion = risk.replacements[0]?.employeeName
      ? ` Best replacement: ${risk.replacements[0].employeeName}.`
      : "";
    const details = `${risk.actualHours.toFixed(1)} worked + ${risk.remainingScheduledHours.toFixed(1)} remaining = ${risk.projectedHours.toFixed(1)} projected. ${trigger} creates the risk.${risk.unplannedHours ? ` ${risk.unplannedHours.toFixed(1)} hours were unscheduled or covered for someone else.` : ""}${suggestion}`;

    await createOperationIssue({
      issueKey: `overtime-risk:${input.business}:${dashboard.weekStart}:${risk.employeeId}`,
      business: input.business,
      issueType: "Overtime Risk",
      severity: risk.risk === "overtime" ? "Error" : "Warning",
      title: `${risk.employeeName} projected at ${risk.projectedHours.toFixed(1)} hours`,
      details: `${details}${input.source ? ` Source: ${clean(input.source, 120)}.` : ""}`,
      reference: risk.employeeId,
    });

    if (shouldNotify) {
      try {
        const result = await notifyOwnersOfOperationalAlert({
          business: input.business,
          title: risk.risk === "overtime"
            ? `${input.business}: overtime risk for ${risk.employeeName}`
            : `${input.business}: ${risk.employeeName} nearing 40 hours`,
          body: details,
          url: `/ops/overtime?business=${encodeURIComponent(input.business)}`,
          tag: `overtime-${input.business}-${risk.employeeId}-${dashboard.weekStart}`,
        });
        const emailSent = Boolean(result.email && "sent" in result.email && result.email.sent);
        if (result.delivered > 0 || emailSent) {
          await sql`
            UPDATE overtime_risk_alerts SET last_notified_at = NOW()
            WHERE business = ${input.business}
              AND employee_id = ${risk.employeeId}
              AND week_start = ${dashboard.weekStart}
          `;
        }
        notified.push({
          employeeId: risk.employeeId,
          delivered: result.delivered,
          failed: result.failed,
          emailSent,
        });
      } catch (error) {
        console.error("[overtime-risk] owner notification failed", {
          business: input.business,
          employeeId: risk.employeeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const activeIds = activeRisks.map((item) => item.employeeId);
  if (activeIds.length) {
    await sql`
      UPDATE overtime_risk_alerts SET status = 'Resolved', resolved_at = NOW(), last_seen_at = NOW()
      WHERE business = ${input.business} AND week_start = ${dashboard.weekStart} AND status = 'Open'
        AND employee_id NOT IN (
          SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(activeIds)}::jsonb)
        )
    `;
    await sql`
      UPDATE operation_issues SET status = 'Resolved', resolved_at = NOW(), last_seen_at = NOW()
      WHERE business = ${input.business} AND issue_type = 'Overtime Risk' AND status = 'Open'
        AND issue_key LIKE ${`overtime-risk:${input.business}:${dashboard.weekStart}:%`}
        AND reference NOT IN (
          SELECT value FROM jsonb_array_elements_text(${JSON.stringify(activeIds)}::jsonb)
        )
    `;
  } else {
    await sql`
      UPDATE overtime_risk_alerts SET status = 'Resolved', resolved_at = NOW(), last_seen_at = NOW()
      WHERE business = ${input.business} AND week_start = ${dashboard.weekStart} AND status = 'Open'
    `;
    await sql`
      UPDATE operation_issues SET status = 'Resolved', resolved_at = NOW(), last_seen_at = NOW()
      WHERE business = ${input.business} AND issue_type = 'Overtime Risk' AND status = 'Open'
        AND issue_key LIKE ${`overtime-risk:${input.business}:${dashboard.weekStart}:%`}
    `;
  }

  return { ...dashboard, notified };
}

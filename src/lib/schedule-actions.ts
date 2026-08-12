import { getSql } from "@/lib/db";
import { ensureScheduleMealSchema, normalizeScheduledMealFields } from "@/lib/schedule-meal-storage";
import { normalizeScheduleTimeRange } from "@/lib/schedule-time-range";
import { enforceScheduleTimeOff } from "@/lib/schedule-time-off";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

export async function updateScheduleShiftSafely(input: {
  id: string;
  business: Business;
  employeeId?: string | null;
  position?: string;
  startsAt?: string;
  endsAt?: string;
  mealBreakStart?: string | null;
  mealBreakMinutes?: number;
  extraMealBreakStart?: string | null;
  extraMealBreakMinutes?: number;
  status?: "Draft" | "Published" | "Open" | "Cancelled";
  notes?: string;
  acknowledgePendingTimeOff?: boolean;
}) {
  await ensureScheduleMealSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM schedule_shifts
    WHERE id = ${input.id} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const current = rows[0];
  if (!current) throw new Error("Shift not found.");

  const { start, end } = normalizeScheduleTimeRange(
    input.startsAt ?? current.starts_at,
    input.endsAt ?? current.ends_at,
  );

  const meals = normalizeScheduledMealFields({
    startsAt: start,
    endsAt: end,
    mealBreakStart: input.mealBreakStart === undefined ? current.meal_break_start : input.mealBreakStart,
    mealBreakMinutes: input.mealBreakMinutes === undefined ? current.meal_break_minutes : input.mealBreakMinutes,
    extraMealBreakStart: input.extraMealBreakStart === undefined ? current.extra_meal_break_start : input.extraMealBreakStart,
    extraMealBreakMinutes: input.extraMealBreakMinutes === undefined ? current.extra_meal_break_minutes : input.extraMealBreakMinutes,
  });

  const status = (input.status || clean(current.status, 30)) as "Draft" | "Published" | "Open" | "Cancelled";
  const requestedEmployee = input.employeeId === undefined
    ? (current.employee_id ? String(current.employee_id) : null)
    : input.employeeId;
  const employeeId = status === "Open" ? null : requestedEmployee;
  if (status === "Published" && !employeeId) {
    throw new Error("Published assigned shifts require an employee.");
  }

  if (employeeId && status !== "Cancelled") {
    const employee = await sql`
      SELECT id FROM employees
      WHERE id = ${employeeId} AND business = ${input.business} AND active = TRUE
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (!employee[0]) throw new Error("Employee is not active for this location.");

    const overlap = await sql`
      SELECT id FROM schedule_shifts
      WHERE employee_id = ${employeeId}
        AND id <> ${input.id}
        AND status <> 'Cancelled'
        AND starts_at < ${end.toISOString()}
        AND ends_at > ${start.toISOString()}
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (overlap[0]) throw new Error("That employee already has an overlapping shift.");
    await enforceScheduleTimeOff({
      business: input.business,
      employeeId,
      startsAt: start,
      endsAt: end,
      acknowledgePendingTimeOff: input.acknowledgePendingTimeOff,
    });
  }

  await sql`
    UPDATE schedule_shifts SET
      employee_id = ${employeeId},
      position = ${clean(input.position ?? current.position, 100)},
      starts_at = ${start.toISOString()},
      ends_at = ${end.toISOString()},
      meal_break_start = ${meals.mealBreakStart},
      meal_break_minutes = ${meals.mealBreakMinutes},
      extra_meal_break_start = ${meals.extraMealBreakStart},
      extra_meal_break_minutes = ${meals.extraMealBreakMinutes},
      status = ${status},
      notes = ${clean(input.notes ?? current.notes, 1000)},
      published_at = CASE
        WHEN ${status} = 'Draft' THEN NULL
        WHEN ${status} IN ('Published', 'Open') THEN COALESCE(published_at, NOW())
        ELSE published_at
      END,
      updated_at = NOW()
    WHERE id = ${input.id}
  `;

  return { id: input.id };
}

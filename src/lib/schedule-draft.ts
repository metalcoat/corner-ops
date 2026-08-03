import { getSql } from "@/lib/db";
import { ensureScheduleMealSchema, normalizeScheduledMealFields } from "@/lib/schedule-meal-storage";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

export async function createScheduleDraftWithMeals(input: {
  business: Business;
  employeeId?: string | null;
  position: string;
  startsAt: string;
  endsAt: string;
  mealBreakStart?: string | null;
  mealBreakMinutes?: number;
  extraMealBreakStart?: string | null;
  extraMealBreakMinutes?: number;
  notes?: string;
  actor: string;
}) {
  await ensureScheduleMealSchema();
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Shift date or time is invalid.");
  if (end <= start) throw new Error("Shift end must be after the start.");
  const position = clean(input.position, 100);
  if (!position) throw new Error("Shift position is required.");
  const meals = normalizeScheduledMealFields({
    startsAt: start,
    endsAt: end,
    mealBreakStart: input.mealBreakStart,
    mealBreakMinutes: input.mealBreakMinutes,
    extraMealBreakStart: input.extraMealBreakStart,
    extraMealBreakMinutes: input.extraMealBreakMinutes,
  });

  const sql = getSql();
  if (input.employeeId) {
    const employee = await sql`
      SELECT id FROM employees
      WHERE id = ${input.employeeId} AND business = ${input.business} AND active = TRUE
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (!employee[0]) throw new Error("Employee is not active for this location.");

    const overlap = await sql`
      SELECT id FROM schedule_shifts
      WHERE employee_id = ${input.employeeId}
        AND status <> 'Cancelled'
        AND starts_at < ${end.toISOString()}
        AND ends_at > ${start.toISOString()}
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (overlap[0]) throw new Error("That employee already has an overlapping shift.");
  }

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO schedule_shifts (
      id, business, employee_id, position, starts_at, ends_at,
      meal_break_start, meal_break_minutes,
      extra_meal_break_start, extra_meal_break_minutes,
      status, notes, created_by, published_at
    ) VALUES (
      ${id}, ${input.business}, ${input.employeeId || null}, ${position},
      ${start.toISOString()}, ${end.toISOString()},
      ${meals.mealBreakStart}, ${meals.mealBreakMinutes},
      ${meals.extraMealBreakStart}, ${meals.extraMealBreakMinutes},
      'Draft', ${clean(input.notes, 1000)}, ${input.actor}, NULL
    )
  `;
  return { id, status: "Draft" };
}

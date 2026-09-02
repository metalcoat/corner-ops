import { getSql } from "@/lib/db";
import { ensureScheduleMealSchema } from "@/lib/schedule-meal-storage";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

function normalizeWeek(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must be a valid date.`);
  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date.`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export async function copyScheduleWeekToTarget(input: {
  business: Business;
  sourceWeekStart: string;
  targetWeekStart: string;
  actor: string;
}) {
  await ensureScheduleMealSchema();
  const sourceWeekStart = normalizeWeek(input.sourceWeekStart, "Source week");
  const targetWeekStart = normalizeWeek(input.targetWeekStart, "Target week");
  if (sourceWeekStart === targetWeekStart) throw new Error("Source and target weeks must be different.");

  const sql = getSql();
  const sourceSummary = await sql`
    SELECT
      COUNT(*)::INTEGER AS source_count,
      COUNT(*) FILTER (
        WHERE s.employee_id IS NOT NULL AND COALESCE(e.active, FALSE) = FALSE
      )::INTEGER AS inactive_employee_count
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id AND e.business = s.business
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${sourceWeekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < ((${sourceWeekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
  ` as unknown as Array<{ source_count: number; inactive_employee_count: number }>;

  const sourceCount = Number(sourceSummary[0]?.source_count || 0);
  const inactiveEmployeeCount = Number(sourceSummary[0]?.inactive_employee_count || 0);
  if (!sourceCount) throw new Error("No shifts were found in the selected source week.");

  const inserted = await sql`
    WITH source_shifts AS (
      SELECT
        s.*,
        COALESCE(e.active, FALSE) AS employee_active,
        ((s.starts_at AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} AS target_starts_at,
        ((s.ends_at AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} AS target_ends_at,
        CASE WHEN s.meal_break_start IS NULL THEN NULL ELSE ((s.meal_break_start AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} END AS target_meal_break_start,
        CASE WHEN s.extra_meal_break_start IS NULL THEN NULL ELSE ((s.extra_meal_break_start AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} END AS target_extra_meal_break_start
      FROM schedule_shifts s
      LEFT JOIN employees e ON e.id = s.employee_id AND e.business = s.business
      WHERE s.business = ${input.business}
        AND s.starts_at >= (${sourceWeekStart}::date AT TIME ZONE ${TIME_ZONE})
        AND s.starts_at < ((${sourceWeekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
        AND s.status <> 'Cancelled'
    ), prepared AS (
      SELECT source_shifts.*,
        CASE
          WHEN employee_active = TRUE AND employee_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM time_off_requests t
            WHERE t.business = source_shifts.business
              AND t.employee_id = source_shifts.employee_id
              AND t.status = 'Approved'
              AND t.starts_on <= ((source_shifts.target_ends_at - INTERVAL '1 millisecond') AT TIME ZONE ${TIME_ZONE})::date
              AND t.ends_on >= (source_shifts.target_starts_at AT TIME ZONE ${TIME_ZONE})::date
          ) THEN employee_id
          ELSE NULL
        END AS target_employee_id
      FROM source_shifts
    )
    INSERT INTO schedule_shifts (
      id, business, employee_id, position, starts_at, ends_at,
      meal_break_start, meal_break_minutes,
      extra_meal_break_start, extra_meal_break_minutes,
      status, notes, created_by, published_at, created_at, updated_at
    )
    SELECT
      gen_random_uuid(), business, target_employee_id, position, target_starts_at, target_ends_at,
      target_meal_break_start, meal_break_minutes, target_extra_meal_break_start, extra_meal_break_minutes,
      'Draft', notes, ${input.actor}, NULL, NOW(), NOW()
    FROM prepared
    WHERE NOT EXISTS (
      SELECT 1 FROM schedule_shifts existing
      WHERE existing.business = prepared.business
        AND existing.status <> 'Cancelled'
        AND existing.employee_id IS NOT DISTINCT FROM prepared.target_employee_id
        AND existing.position = prepared.position
        AND existing.starts_at = prepared.target_starts_at
        AND existing.ends_at = prepared.target_ends_at
    )
    RETURNING id, employee_id
  ` as unknown as Array<{ id: string; employee_id: string | null }>;

  return {
    sourceWeekStart,
    targetWeekStart,
    sourceShifts: sourceCount,
    copied: inserted.length,
    skippedDuplicates: Math.max(0, sourceCount - inserted.length),
    inactiveEmployeesUnassigned: inactiveEmployeeCount,
    copiedUnassigned: inserted.filter((row) => !row.employee_id).length,
  };
}

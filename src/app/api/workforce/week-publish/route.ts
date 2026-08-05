import { canAccessBusiness, getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { ensurePostgresStringTimestamps } from "@/lib/postgres-string-timestamps";
import { publishValidatedScheduleWeek } from "@/lib/schedule-publish-validation";
import { ensureStaffNotificationSchema } from "@/lib/staff-notifications";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const TIME_ZONE = "America/New_York";

type ShiftRow = {
  id: string;
  employee_id: string | null;
  position: string;
  starts_at: string | Date;
  ends_at: string | Date;
  meal_break_start: string | Date | null;
  meal_break_minutes: number;
  extra_meal_break_start: string | Date | null;
  extra_meal_break_minutes: number;
  notes: string;
  status: string;
};

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function detailsObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function storedSchedules(value: unknown): Record<string, string> {
  const schedules = detailsObject(value).employeeSchedules;
  if (!schedules || typeof schedules !== "object" || Array.isArray(schedules)) return {};
  return Object.fromEntries(
    Object.entries(schedules as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function sortableTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function currentSchedules(shifts: ShiftRow[]): Record<string, string> {
  const grouped = new Map<string, ShiftRow[]>();
  for (const shift of shifts) {
    if (!shift.employee_id) continue;
    const rows = grouped.get(shift.employee_id) || [];
    rows.push(shift);
    grouped.set(shift.employee_id, rows);
  }

  return Object.fromEntries(Array.from(grouped.entries()).map(([employeeId, rows]) => [
    employeeId,
    rows
      .sort((left, right) => sortableTimestamp(left.starts_at).localeCompare(sortableTimestamp(right.starts_at)) || String(left.id).localeCompare(String(right.id)))
      .map((shift) => JSON.stringify({
        id: shift.id,
        position: clean(shift.position, 100),
        startsAt: sortableTimestamp(shift.starts_at),
        endsAt: sortableTimestamp(shift.ends_at),
        mealBreakStart: shift.meal_break_start ? sortableTimestamp(shift.meal_break_start) : null,
        mealBreakMinutes: Number(shift.meal_break_minutes || 0),
        extraMealBreakStart: shift.extra_meal_break_start ? sortableTimestamp(shift.extra_meal_break_start) : null,
        extraMealBreakMinutes: Number(shift.extra_meal_break_minutes || 0),
        notes: clean(shift.notes, 1000),
      }))
      .join("|"),
  ]));
}

async function installScheduleMessageCompatibility() {
  const sql = getSql();
  await sql`
    CREATE OR REPLACE FUNCTION corner_ops_normalize_employee_message_type()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.message_type = 'Schedule' THEN
        NEW.message_type := 'Announcement';
      END IF;
      RETURN NEW;
    END;
    $$
  `;
  await sql`DROP TRIGGER IF EXISTS corner_ops_schedule_message_type ON employee_messages`;
  await sql`
    CREATE TRIGGER corner_ops_schedule_message_type
    BEFORE INSERT OR UPDATE OF message_type ON employee_messages
    FOR EACH ROW
    EXECUTE FUNCTION corner_ops_normalize_employee_message_type()
  `;
}

async function recoverDraftState(business: Business, weekStart: string) {
  const sql = getSql();
  const shifts = await sql`
    SELECT id, employee_id, position, starts_at, ends_at,
      meal_break_start, meal_break_minutes,
      extra_meal_break_start, extra_meal_break_minutes,
      notes, status
    FROM schedule_shifts
    WHERE business = ${business}
      AND starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND status <> 'Cancelled'
    ORDER BY starts_at, id
  ` as unknown as ShiftRow[];

  if (!shifts.length || shifts.some((shift) => shift.status === "Draft")) {
    return { recovered: false, affectedEmployeeIds: [] as string[] };
  }

  const publications = await sql`
    SELECT details
    FROM schedule_publications
    WHERE business = ${business} AND week_start = ${weekStart}
    ORDER BY published_at DESC
    LIMIT 1
  ` as unknown as Array<{ details: unknown }>;
  const previous = storedSchedules(publications[0]?.details);
  if (!Object.keys(previous).length) return { recovered: false, affectedEmployeeIds: [] as string[] };

  const current = currentSchedules(shifts);
  const employeeIds = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const affectedEmployeeIds = Array.from(employeeIds).filter(
    (employeeId) => (previous[employeeId] || "") !== (current[employeeId] || ""),
  );
  if (!affectedEmployeeIds.length) return { recovered: false, affectedEmployeeIds };

  let marked = 0;
  for (const employeeId of affectedEmployeeIds) {
    const result = await sql`
      UPDATE schedule_shifts
      SET status = 'Draft', updated_at = NOW()
      WHERE business = ${business}
        AND employee_id = ${employeeId}
        AND starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
        AND starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
        AND status <> 'Cancelled'
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    marked += result.length;
  }

  if (!marked) {
    await sql`
      UPDATE schedule_shifts
      SET status = 'Draft', updated_at = NOW()
      WHERE id = ${shifts[0].id}
    `;
  }

  return { recovered: true, affectedEmployeeIds };
}

export async function POST(request: Request) {
  try {
    ensurePostgresStringTimestamps();
    const session = await getSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const weekStart = String(body.weekStart || "");
    await ensureStaffNotificationSchema();
    await installScheduleMessageCompatibility();
    const recovery = await recoverDraftState(business, weekStart);
    const result = await publishValidatedScheduleWeek({
      business,
      weekStart,
      actor: session.displayName,
    });
    return Response.json({ ...result, recoveredDraftState: recovery.recovered });
  } catch (error) {
    const candidate = error as { code?: unknown };
    if (candidate?.code) return apiError(error);
    return Response.json({
      error: error instanceof Error ? error.message : "The schedule could not be published.",
    }, { status: 400 });
  }
}

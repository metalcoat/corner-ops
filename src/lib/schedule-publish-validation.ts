import { getSql } from "@/lib/db";
import { ensureScheduleMealSchema } from "@/lib/schedule-meal-storage";
import { deliverSchedulePublicationSms } from "@/lib/schedule-publication-sms";
import { analyzeSchedule } from "@/lib/schedule-validation";
import { publishBusinessScheduleWeek } from "@/lib/business-schedule-publication";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

function validWeekStart(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid schedule week.");
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDay() !== 1) throw new Error("Schedule weeks must start on Monday.");
  return value;
}

function localStamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export async function publishValidatedScheduleWeek(input: {
  business: Business;
  weekStart: string;
  actor: string;
  allowOvertime?: boolean;
}) {
  await ensureScheduleMealSchema();
  const weekStart = validWeekStart(input.weekStart);
  const rows = await getSql()`
    SELECT s.id,
      CASE WHEN e.active IS TRUE THEN s.employee_id ELSE NULL END AS employee_id,
      CASE WHEN e.active IS TRUE THEN e.name ELSE 'Open / unassigned' END AS employee_name,
      s.starts_at, s.ends_at,
      s.meal_break_start, s.meal_break_minutes,
      s.extra_meal_break_start, s.extra_meal_break_minutes,
      s.status
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${weekStart}::date::timestamp AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < (((${weekStart}::date + 7)::timestamp) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
    ORDER BY s.starts_at, e.name
  ` as unknown as Array<{
    id: string;
    employee_id: string | null;
    employee_name: string | null;
    starts_at: string;
    ends_at: string;
    meal_break_start: string | null;
    meal_break_minutes: number;
    extra_meal_break_start: string | null;
    extra_meal_break_minutes: number;
    status: string;
  }>;

  if (!rows.length) throw new Error("There are no shifts to publish for this week.");
  const analysis = analyzeSchedule(rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || "Unassigned",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    mealBreakStart: row.meal_break_start,
    mealBreakMinutes: Number(row.meal_break_minutes || 0),
    extraMealBreakStart: row.extra_meal_break_start,
    extraMealBreakMinutes: Number(row.extra_meal_break_minutes || 0),
    status: row.status,
  })), { enforceLoneWorker: input.business === "Corner Deli" });

  const approvedTimeOffConflicts = await getSql()`
    SELECT s.id AS shift_id, e.name AS employee_name, s.starts_at
    FROM schedule_shifts s
    JOIN employees e ON e.id = s.employee_id
    JOIN time_off_requests t ON t.employee_id = s.employee_id AND t.business = s.business
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${weekStart}::date::timestamp AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < (((${weekStart}::date + 7)::timestamp) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
      AND e.active = TRUE
      AND t.status = 'Approved'
      AND t.starts_on <= ((s.ends_at - INTERVAL '1 millisecond') AT TIME ZONE ${TIME_ZONE})::date
      AND t.ends_on >= (s.starts_at AT TIME ZONE ${TIME_ZONE})::date
    ORDER BY s.starts_at, e.name
  ` as unknown as Array<{ shift_id: string; employee_name: string; starts_at: string }>;

  const problems: string[] = [];
  if (approvedTimeOffConflicts.length) {
    problems.push(`Approved time off conflicts: ${approvedTimeOffConflicts.slice(0, 8).map((item) => `${item.employee_name} at ${localStamp(item.starts_at)}`).join("; ")}. Reassign or open these shifts.`);
  }
  if (analysis.overForty.length && !input.allowOvertime) {
    problems.push(`Overtime approval required: ${analysis.overForty.map((employee) => `${employee.employeeName} (${employee.hours.toFixed(1)} hrs)`).join(", ")}. Confirm the overtime in the schedule publisher.`);
  }
  if (analysis.overlaps.length) {
    problems.push(`Overlapping shifts: ${analysis.overlaps.slice(0, 4).map((overlap) => `${overlap.employeeName} at ${localStamp(overlap.startsAt)}`).join("; ")}`);
  }
  if (analysis.coverageGaps.length) {
    problems.push(`Coverage gaps: ${analysis.coverageGaps.slice(0, 6).map((gap) => `${localStamp(gap.startsAt)}–${localTime(gap.endsAt)} (${gap.minutes} min)`).join("; ")}`);
  }
  if (input.business === "Corner Deli" && analysis.loneWorkerViolations.length) {
    problems.push(`Alone over 30 minutes: ${analysis.loneWorkerViolations.slice(0, 4).map((violation) => `${violation.employeeName}, ${localStamp(violation.startsAt)}–${localTime(violation.endsAt)} (${violation.minutes} min)`).join("; ")}`);
  }
  // Tiki normally runs one bartender at a time, so an off-duty meal would leave the bar uncovered.
  // Keep Corner Deli meal compliance intact, but do not require scheduled off-duty meals for Tiki.
  if (input.business === "Corner Deli" && analysis.mealPeriodViolations.length) {
    problems.push(`Meal periods: ${analysis.mealPeriodViolations.slice(0, 6).map((violation) => `${violation.employeeName}, ${localStamp(violation.startsAt)}: ${violation.message}`).join("; ")}`);
  }

  if (problems.length) {
    throw new Error(`Schedule cannot be published. ${problems.join(" | ")}`);
  }

  const publication = await publishBusinessScheduleWeek({
    business: input.business,
    weekStart,
    actor: input.actor,
    overtimeOverride: input.allowOvertime
      ? analysis.overForty.map((employee) => ({
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          hours: employee.hours,
        }))
      : [],
  });
  const duplicate = "duplicate" in publication && publication.duplicate === true;
  const employeeIds = "affectedEmployeeIds" in publication && Array.isArray(publication.affectedEmployeeIds)
    ? publication.affectedEmployeeIds.filter((value): value is string => typeof value === "string" && Boolean(value))
    : [];
  const mode = publication.mode === "initial" || publication.mode === "changes" || publication.mode === "resend"
    ? publication.mode
    : "changes";

  if (duplicate || !publication.publicationId) return publication;

  try {
    const sms = await deliverSchedulePublicationSms({
      business: input.business,
      weekStart,
      publicationId: String(publication.publicationId),
      employeeIds,
      mode,
    });
    return { ...publication, sms };
  } catch (error) {
    console.error("[schedule-sms] schedule published but SMS delivery failed", error);
    return {
      ...publication,
      sms: {
        provider: "telnyx" as const,
        configured: true,
        sent: 0,
        failed: 1,
        missingPhone: 0,
        notOptedIn: 0,
        skipped: employeeIds.length,
        failures: [{ employeeId: "", message: error instanceof Error ? error.message : String(error) }],
        accepted: [],
      },
    };
  }
}

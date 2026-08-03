import { getSql } from "@/lib/db";
import { analyzeSchedule } from "@/lib/schedule-validation";
import { publishScheduleWeek } from "@/lib/staff-notifications";
import type { Business } from "@/lib/types";
import { ensureWorkforceSchema } from "@/lib/workforce";

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

export async function publishValidatedScheduleWeek(input: {
  business: Business;
  weekStart: string;
  actor: string;
}) {
  await ensureWorkforceSchema();
  const weekStart = validWeekStart(input.weekStart);
  const rows = await getSql()`
    SELECT s.id, s.employee_id, e.name AS employee_name, s.starts_at, s.ends_at, s.status
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
    ORDER BY s.starts_at, e.name
  ` as unknown as Array<{
    id: string;
    employee_id: string | null;
    employee_name: string | null;
    starts_at: string;
    ends_at: string;
    status: string;
  }>;

  if (!rows.length) throw new Error("There are no shifts to publish for this week.");
  const analysis = analyzeSchedule(rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || "Unassigned",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  })));

  const problems: string[] = [];
  if (analysis.overForty.length) {
    problems.push(`Over 40 hours: ${analysis.overForty.map((employee) => `${employee.employeeName} (${employee.hours.toFixed(1)} hrs)`).join(", ")}`);
  }
  if (analysis.overlaps.length) {
    problems.push(`Overlapping shifts: ${analysis.overlaps.slice(0, 4).map((overlap) => `${overlap.employeeName} at ${localStamp(overlap.startsAt)}`).join("; ")}`);
  }
  if (analysis.loneWorkerViolations.length) {
    problems.push(`Alone over 30 minutes: ${analysis.loneWorkerViolations.slice(0, 4).map((violation) => `${violation.employeeName}, ${localStamp(violation.startsAt)}–${new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(violation.endsAt))} (${violation.minutes} min)`).join("; ")}`);
  }

  if (problems.length) {
    throw new Error(`Schedule cannot be published. ${problems.join(" | ")}`);
  }

  return publishScheduleWeek(input);
}

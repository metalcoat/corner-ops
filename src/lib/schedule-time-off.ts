import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

export type ScheduleTimeOffConflict = {
  id: string;
  status: "Pending" | "Approved";
  startsOn: string;
  endsOn: string;
  employeeName: string;
};

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

function rangeLabel(conflict: ScheduleTimeOffConflict): string {
  return conflict.startsOn === conflict.endsOn
    ? dateLabel(conflict.startsOn)
    : `${dateLabel(conflict.startsOn)} through ${dateLabel(conflict.endsOn)}`;
}

export async function scheduleTimeOffConflicts(input: {
  business: Business;
  employeeId: string;
  startsAt: string | Date;
  endsAt: string | Date;
}): Promise<ScheduleTimeOffConflict[]> {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];

  const rows = await getSql()`
    SELECT t.id, t.status, t.starts_on::text AS starts_on, t.ends_on::text AS ends_on, e.name AS employee_name
    FROM time_off_requests t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.business = ${input.business}
      AND t.employee_id = ${input.employeeId}
      AND t.status IN ('Pending', 'Approved')
      AND t.starts_on <= ((${end.toISOString()}::timestamptz - INTERVAL '1 millisecond') AT TIME ZONE ${TIME_ZONE})::date
      AND t.ends_on >= (${start.toISOString()}::timestamptz AT TIME ZONE ${TIME_ZONE})::date
    ORDER BY CASE WHEN t.status = 'Approved' THEN 0 ELSE 1 END, t.starts_on
  ` as unknown as Array<{
    id: string;
    status: "Pending" | "Approved";
    starts_on: string;
    ends_on: string;
    employee_name: string;
  }>;

  return rows.map((row) => ({
    id: String(row.id),
    status: row.status,
    startsOn: String(row.starts_on),
    endsOn: String(row.ends_on),
    employeeName: String(row.employee_name || "Employee"),
  }));
}

export async function enforceScheduleTimeOff(input: {
  business: Business;
  employeeId: string;
  startsAt: string | Date;
  endsAt: string | Date;
  acknowledgePendingTimeOff?: boolean;
}) {
  const conflicts = await scheduleTimeOffConflicts(input);
  const approved = conflicts.find((conflict) => conflict.status === "Approved");
  if (approved) {
    throw new Error(`${approved.employeeName} has approved time off ${rangeLabel(approved)}. Reassign this shift or leave it open.`);
  }
  const pending = conflicts.find((conflict) => conflict.status === "Pending");
  if (pending && !input.acknowledgePendingTimeOff) {
    throw new Error(`${pending.employeeName} has a pending time-off request ${rangeLabel(pending)}. Review the request or acknowledge the warning before assigning this shift.`);
  }
  return { conflicts, pending: conflicts.filter((conflict) => conflict.status === "Pending") };
}

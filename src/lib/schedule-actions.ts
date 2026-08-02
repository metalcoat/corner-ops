import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";
import { ensureWorkforceSchema } from "@/lib/workforce";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function dateValue(value: unknown, label: string): Date {
  const result = new Date(String(value || ""));
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid.`);
  return result;
}

export async function updateScheduleShiftSafely(input: {
  id: string;
  business: Business;
  employeeId?: string | null;
  position?: string;
  startsAt?: string;
  endsAt?: string;
  status?: "Draft" | "Published" | "Open" | "Cancelled";
  notes?: string;
}) {
  await ensureWorkforceSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM schedule_shifts
    WHERE id = ${input.id} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const current = rows[0];
  if (!current) throw new Error("Shift not found.");

  const start = input.startsAt ? dateValue(input.startsAt, "Shift start") : new Date(String(current.starts_at));
  const end = input.endsAt ? dateValue(input.endsAt, "Shift end") : new Date(String(current.ends_at));
  if (end <= start) throw new Error("Shift end must be after the start.");

  const status = (input.status || clean(current.status, 30)) as "Draft" | "Published" | "Open" | "Cancelled";
  const requestedEmployee = input.employeeId === undefined
    ? (current.employee_id ? String(current.employee_id) : null)
    : input.employeeId;
  const employeeId = status === "Open" ? null : requestedEmployee;
  if (status !== "Open" && status !== "Cancelled" && !employeeId) {
    throw new Error("Choose an employee or mark the shift open.");
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
  }

  await sql`
    UPDATE schedule_shifts SET
      employee_id = ${employeeId},
      position = ${clean(input.position ?? current.position, 100)},
      starts_at = ${start.toISOString()},
      ends_at = ${end.toISOString()},
      status = ${status},
      notes = ${clean(input.notes ?? current.notes, 1000)},
      published_at = CASE
        WHEN ${status} IN ('Published', 'Open') THEN COALESCE(published_at, NOW())
        ELSE published_at
      END,
      updated_at = NOW()
    WHERE id = ${input.id}
  `;

  return { id: input.id };
}

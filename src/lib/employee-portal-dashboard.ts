import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import { ensureWorkforceSchema } from "@/lib/workforce";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function mapShift(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    business: row.business as Business,
    employeeId: row.employee_id ? String(row.employee_id) : null,
    employeeName: clean(row.employee_name, 120),
    position: clean(row.position, 100),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    status: clean(row.status, 30),
    notes: clean(row.notes, 1000),
    publishedAt: row.published_at ? String(row.published_at) : null,
  };
}

export async function employeePortalDashboard(session: EmployeeSession) {
  await ensureWorkforceSchema();
  const sql = getSql();
  const employeeRows = await sql`
    SELECT id, business, name, position, active
    FROM employees
    WHERE id = ${session.employeeId}
      AND business = ${session.business}
      AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{
    id: string;
    business: Business;
    name: string;
    position: string;
    active: boolean;
  }>;
  const employee = employeeRows[0];
  if (!employee) throw new Error("Employee is not active for this location.");

  const [teamShifts, messages, requests, corrections, timeOff, availability, recentTime] = await Promise.all([
    sql`
      SELECT s.id, s.business, s.employee_id, e.name AS employee_name,
        s.position, s.starts_at, s.ends_at, s.status, s.notes, s.published_at
      FROM schedule_shifts s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.business = ${session.business}
        AND s.status IN ('Published', 'Open')
        AND s.starts_at >= NOW() - INTERVAL '14 days'
        AND s.starts_at < NOW() + INTERVAL '90 days'
      ORDER BY s.starts_at
    `,
    sql`
      SELECT m.id, m.sender_employee_id, m.sender_name,
        recipient.name AS recipient_name, m.message_type, m.body, m.created_at
      FROM employee_messages m
      LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
      WHERE m.business = ${session.business}
        AND (
          m.message_type IN ('Team', 'Announcement')
          OR m.sender_employee_id = ${session.employeeId}
          OR m.recipient_employee_id = ${session.employeeId}
        )
      ORDER BY m.created_at DESC
      LIMIT 5
    `,
    sql`
      SELECT r.id, r.request_type, r.requester_employee_id, r.target_employee_id,
        requester.name AS requester_name, target.name AS target_name,
        r.employee_response, r.status, r.note, r.created_at,
        s.starts_at, s.ends_at, s.position,
        r.offered_shift_id, offered.starts_at AS offered_starts_at,
        offered.ends_at AS offered_ends_at
      FROM shift_requests r
      JOIN employees requester ON requester.id = r.requester_employee_id
      LEFT JOIN employees target ON target.id = r.target_employee_id
      JOIN schedule_shifts s ON s.id = r.shift_id
      LEFT JOIN schedule_shifts offered ON offered.id = r.offered_shift_id
      WHERE r.business = ${session.business}
        AND (r.requester_employee_id = ${session.employeeId} OR r.target_employee_id = ${session.employeeId})
      ORDER BY r.created_at DESC
      LIMIT 100
    `,
    sql`
      SELECT id, source_type, reason, status, requested_clock_in,
        requested_clock_out, created_at
      FROM time_correction_requests
      WHERE employee_id = ${session.employeeId}
      ORDER BY created_at DESC
      LIMIT 100
    `,
    sql`
      SELECT id, starts_on, ends_on, reason, status, created_at
      FROM time_off_requests
      WHERE employee_id = ${session.employeeId}
      ORDER BY created_at DESC
      LIMIT 100
    `,
    sql`
      SELECT weekday, available, available_from, available_to, notes
      FROM employee_availability
      WHERE employee_id = ${session.employeeId}
      ORDER BY weekday
    `,
    session.business === "Tiki"
      ? sql`
          SELECT id, clock_in, clock_out, position, status, source
          FROM time_entries
          WHERE employee_id = ${session.employeeId}
            AND clock_in >= NOW() - INTERVAL '60 days'
          ORDER BY clock_in DESC
          LIMIT 100
        `
      : sql`
          SELECT id, clock_in, clock_out, position,
            CASE WHEN clock_in IS NULL OR clock_out IS NULL THEN 'Needs Review' ELSE 'Imported' END AS status,
            'Rezku' AS source, reported_hours
          FROM rezku_shifts
          WHERE LOWER(employee_name) = LOWER(${employee.name})
            AND COALESCE(clock_in, clock_out) >= NOW() - INTERVAL '60 days'
          ORDER BY COALESCE(clock_in, clock_out) DESC
          LIMIT 100
        `,
  ]);

  return {
    employee,
    business: session.business,
    teamShifts: (teamShifts as unknown as Array<Record<string, unknown>>).map(mapShift),
    messages,
    shiftRequests: requests,
    corrections,
    timeOff,
    availability,
    recentTime,
  };
}

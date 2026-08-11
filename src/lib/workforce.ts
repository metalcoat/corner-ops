import { ensureSchema, getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import { sendStaffNotification } from "@/lib/staff-notifications";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
let workforceSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function dateValue(value: unknown, label: string): Date {
  const result = new Date(String(value || ""));
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid.`);
  return result;
}

function hoursBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 10000) / 10000);
}

export function ensureWorkforceSchema(): Promise<void> {
  if (!workforceSchemaPromise) {
    workforceSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS schedule_shifts (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
          position TEXT NOT NULL DEFAULT '',
          starts_at TIMESTAMPTZ NOT NULL,
          ends_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Open', 'Cancelled')),
          notes TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          published_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (ends_at > starts_at)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS schedule_shifts_business_start_idx ON schedule_shifts (business, starts_at, status)`;
      await sql`CREATE INDEX IF NOT EXISTS schedule_shifts_employee_idx ON schedule_shifts (employee_id, starts_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS employee_availability (
          id UUID PRIMARY KEY,
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
          available BOOLEAN NOT NULL DEFAULT TRUE,
          available_from TEXT NOT NULL DEFAULT '',
          available_to TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (employee_id, weekday)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS time_off_requests (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          starts_on DATE NOT NULL,
          ends_on DATE NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
          manager_note TEXT NOT NULL DEFAULT '',
          reviewed_by TEXT NOT NULL DEFAULT '',
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (ends_on >= starts_on)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS time_off_business_status_idx ON time_off_requests (business, status, starts_on)`;

      await sql`
        CREATE TABLE IF NOT EXISTS shift_requests (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          request_type TEXT NOT NULL CHECK (request_type IN ('Claim', 'Offer', 'Swap')),
          shift_id UUID NOT NULL REFERENCES schedule_shifts(id) ON DELETE CASCADE,
          offered_shift_id UUID REFERENCES schedule_shifts(id) ON DELETE SET NULL,
          requester_employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          target_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
          employee_response TEXT NOT NULL DEFAULT 'Pending' CHECK (employee_response IN ('Pending', 'Accepted', 'Declined', 'Not Required')),
          status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
          note TEXT NOT NULL DEFAULT '',
          manager_note TEXT NOT NULL DEFAULT '',
          reviewed_by TEXT NOT NULL DEFAULT '',
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS shift_requests_business_status_idx ON shift_requests (business, status, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS employee_messages (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          sender_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
          sender_name TEXT NOT NULL,
          recipient_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
          message_type TEXT NOT NULL DEFAULT 'Team' CHECK (message_type IN ('Team', 'Direct', 'Announcement')),
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employee_messages_business_created_idx ON employee_messages (business, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS time_correction_requests (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL CHECK (source_type IN ('Corner Ops', 'Rezku')),
          source_id UUID NOT NULL,
          original_clock_in TIMESTAMPTZ,
          original_clock_out TIMESTAMPTZ,
          requested_clock_in TIMESTAMPTZ,
          requested_clock_out TIMESTAMPTZ,
          original_reported_hours NUMERIC(10,4) NOT NULL DEFAULT 0,
          requested_reported_hours NUMERIC(10,4),
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
          manager_note TEXT NOT NULL DEFAULT '',
          reviewed_by TEXT NOT NULL DEFAULT '',
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS correction_business_status_idx ON time_correction_requests (business, status, created_at DESC)`;
    })().catch((error) => {
      workforceSchemaPromise = null;
      throw error;
    });
  }
  return workforceSchemaPromise;
}

async function employeeForBusiness(employeeId: string, business: Business) {
  const rows = await getSql()`
    SELECT id, business, name, position, active
    FROM employees
    WHERE id = ${employeeId} AND business = ${business}
    LIMIT 1
  ` as unknown as Array<{ id: string; business: Business; name: string; position: string; active: boolean }>;
  if (!rows[0] || !rows[0].active) throw new Error("Employee is not active for this location.");
  return rows[0];
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

export async function workforceDashboard(business: Business) {
  await ensureWorkforceSchema();
  const sql = getSql();
  const [employees, shifts, requests, messages, corrections, timeOff, availability] = await Promise.all([
    sql`
      SELECT id, name, position, role_group, counts_for_tips, active
      FROM employees WHERE business = ${business}
      ORDER BY active DESC, name
    `,
    sql`
      SELECT s.*, e.name AS employee_name
      FROM schedule_shifts s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.business = ${business}
        AND s.starts_at >= NOW() - INTERVAL '21 days'
        AND s.starts_at < NOW() + INTERVAL '120 days'
      ORDER BY s.starts_at
    `,
    sql`
      SELECT r.*, requester.name AS requester_name, target.name AS target_name,
        s.starts_at, s.ends_at, s.position,
        offered.starts_at AS offered_starts_at, offered.ends_at AS offered_ends_at
      FROM shift_requests r
      JOIN employees requester ON requester.id = r.requester_employee_id
      LEFT JOIN employees target ON target.id = r.target_employee_id
      JOIN schedule_shifts s ON s.id = r.shift_id
      LEFT JOIN schedule_shifts offered ON offered.id = r.offered_shift_id
      WHERE r.business = ${business}
      ORDER BY CASE WHEN r.status = 'Pending' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 200
    `,
    sql`
      SELECT m.*, recipient.name AS recipient_name
      FROM employee_messages m
      LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
      WHERE m.business = ${business}
      ORDER BY m.created_at DESC
      LIMIT 150
    `,
    sql`
      SELECT c.*, e.name AS employee_name
      FROM time_correction_requests c
      JOIN employees e ON e.id = c.employee_id
      WHERE c.business = ${business}
      ORDER BY CASE WHEN c.status = 'Pending' THEN 0 ELSE 1 END, c.created_at DESC
      LIMIT 200
    `,
    sql`
      SELECT t.*,
        t.starts_on::text AS starts_on,
        t.ends_on::text AS ends_on,
        e.name AS employee_name
      FROM time_off_requests t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.business = ${business}
      ORDER BY CASE WHEN t.status = 'Pending' THEN 0 ELSE 1 END, t.starts_on DESC
      LIMIT 200
    `,
    sql`
      SELECT a.*, e.name AS employee_name
      FROM employee_availability a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.business = ${business}
      ORDER BY e.name, a.weekday
    `,
  ]);

  return {
    business,
    employees: (employees as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: clean(row.name, 120),
      position: clean(row.position, 100),
      roleGroup: clean(row.role_group, 30),
      countsForTips: Boolean(row.counts_for_tips),
      active: Boolean(row.active),
    })),
    shifts: (shifts as unknown as Array<Record<string, unknown>>).map(mapShift),
    shiftRequests: requests,
    messages,
    corrections,
    timeOff,
    availability,
  };
}

export async function employeeDashboard(session: EmployeeSession) {
  await ensureWorkforceSchema();
  const employee = await employeeForBusiness(session.employeeId, session.business);
  const sql = getSql();
  const [teamShifts, messages, requests, corrections, timeOff, availability, recentTime, directory] = await Promise.all([
    sql`
      SELECT s.*, e.name AS employee_name
      FROM schedule_shifts s
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.business = ${session.business}
        AND s.status IN ('Published', 'Open')
        AND s.starts_at >= NOW() - INTERVAL '14 days'
        AND s.starts_at < NOW() + INTERVAL '90 days'
      ORDER BY s.starts_at
    `,
    sql`
      SELECT m.*, recipient.name AS recipient_name
      FROM employee_messages m
      LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
      WHERE m.business = ${session.business}
        AND (
          m.message_type IN ('Team', 'Announcement')
          OR m.sender_employee_id = ${session.employeeId}
          OR m.recipient_employee_id = ${session.employeeId}
        )
      ORDER BY m.created_at DESC
      LIMIT 120
    `,
    sql`
      SELECT r.*, requester.name AS requester_name, target.name AS target_name,
        s.starts_at, s.ends_at, s.position,
        offered.starts_at AS offered_starts_at, offered.ends_at AS offered_ends_at
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
      SELECT * FROM time_correction_requests
      WHERE employee_id = ${session.employeeId}
      ORDER BY created_at DESC LIMIT 100
    `,
    sql`
      SELECT *,
        starts_on::text AS starts_on,
        ends_on::text AS ends_on
      FROM time_off_requests
      WHERE employee_id = ${session.employeeId}
      ORDER BY created_at DESC LIMIT 100
    `,
    sql`
      SELECT * FROM employee_availability
      WHERE employee_id = ${session.employeeId}
      ORDER BY weekday
    `,
    session.business === "Tiki"
      ? sql`
          SELECT id, clock_in, clock_out, position, status, source
          FROM time_entries
          WHERE employee_id = ${session.employeeId}
            AND clock_in >= NOW() - INTERVAL '60 days'
          ORDER BY clock_in DESC LIMIT 100
        `
      : sql`
          SELECT id, clock_in, clock_out, position,
            CASE WHEN clock_in IS NULL OR clock_out IS NULL THEN 'Needs Review' ELSE 'Imported' END AS status,
            'Rezku' AS source, reported_hours
          FROM rezku_shifts
          WHERE LOWER(employee_name) = LOWER(${employee.name})
            AND COALESCE(clock_in, clock_out) >= NOW() - INTERVAL '60 days'
          ORDER BY COALESCE(clock_in, clock_out) DESC LIMIT 100
        `,
    sql`
      SELECT id, name, position FROM employees
      WHERE business = ${session.business} AND active = TRUE
      ORDER BY name
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
    directory,
  };
}

export async function createScheduleShift(input: {
  business: Business;
  employeeId?: string | null;
  position: string;
  startsAt: string;
  endsAt: string;
  status: "Draft" | "Published" | "Open";
  notes?: string;
  actor: string;
}) {
  await ensureWorkforceSchema();
  const start = dateValue(input.startsAt, "Shift start");
  const end = dateValue(input.endsAt, "Shift end");
  if (end <= start) throw new Error("Shift end must be after the start.");
  if (input.employeeId) await employeeForBusiness(input.employeeId, input.business);
  if (input.status !== "Open" && !input.employeeId) throw new Error("Choose an employee or mark the shift open.");

  const overlap = input.employeeId ? await getSql()`
    SELECT id FROM schedule_shifts
    WHERE employee_id = ${input.employeeId}
      AND status <> 'Cancelled'
      AND starts_at < ${end.toISOString()}
      AND ends_at > ${start.toISOString()}
    LIMIT 1
  ` as unknown as Array<{ id: string }> : [];
  if (overlap[0]) throw new Error("That employee already has an overlapping shift.");

  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO schedule_shifts (
      id, business, employee_id, position, starts_at, ends_at, status, notes, created_by, published_at
    ) VALUES (
      ${id}, ${input.business}, ${input.employeeId || null}, ${clean(input.position, 100)},
      ${start.toISOString()}, ${end.toISOString()}, ${input.status}, ${clean(input.notes, 1000)},
      ${input.actor}, ${input.status === "Draft" ? null : new Date().toISOString()}
    )
  `;
  return { id };
}

export async function updateScheduleShift(input: {
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
  const rows = await getSql()`
    SELECT * FROM schedule_shifts WHERE id = ${input.id} AND business = ${input.business} LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const current = rows[0];
  if (!current) throw new Error("Shift not found.");
  const start = input.startsAt ? dateValue(input.startsAt, "Shift start") : new Date(String(current.starts_at));
  const end = input.endsAt ? dateValue(input.endsAt, "Shift end") : new Date(String(current.ends_at));
  if (end <= start) throw new Error("Shift end must be after the start.");
  const employeeId = input.employeeId === undefined ? (current.employee_id ? String(current.employee_id) : null) : input.employeeId;
  const status = input.status || clean(current.status, 30) as "Draft" | "Published" | "Open" | "Cancelled";
  if (employeeId) await employeeForBusiness(employeeId, input.business);
  if (status !== "Open" && status !== "Cancelled" && !employeeId) throw new Error("Choose an employee or mark the shift open.");

  await getSql()`
    UPDATE schedule_shifts SET
      employee_id = ${status === "Open" ? null : employeeId},
      position = ${clean(input.position ?? current.position, 100)},
      starts_at = ${start.toISOString()},
      ends_at = ${end.toISOString()},
      status = ${status},
      notes = ${clean(input.notes ?? current.notes, 1000)},
      published_at = CASE WHEN ${status} IN ('Published', 'Open') THEN COALESCE(published_at, NOW()) ELSE published_at END,
      updated_at = NOW()
    WHERE id = ${input.id}
  `;
  return { id: input.id };
}

export async function copyScheduleWeek(input: { business: Business; sourceWeekStart: string; actor: string }) {
  await ensureWorkforceSchema();
  const start = dateValue(`${input.sourceWeekStart}T04:00:00-04:00`, "Week start");
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const rows = await getSql()`
    SELECT employee_id, position, starts_at, ends_at, status, notes
    FROM schedule_shifts
    WHERE business = ${input.business}
      AND starts_at >= ${start.toISOString()} AND starts_at < ${end.toISOString()}
      AND status <> 'Cancelled'
    ORDER BY starts_at
  ` as unknown as Array<Record<string, unknown>>;
  for (const row of rows) {
    const nextStart = new Date(new Date(String(row.starts_at)).getTime() + 7 * 24 * 60 * 60 * 1000);
    const nextEnd = new Date(new Date(String(row.ends_at)).getTime() + 7 * 24 * 60 * 60 * 1000);
    await getSql()`
      INSERT INTO schedule_shifts (
        id, business, employee_id, position, starts_at, ends_at, status, notes, created_by, published_at
      ) VALUES (
        ${crypto.randomUUID()}, ${input.business}, ${row.employee_id ? String(row.employee_id) : null},
        ${clean(row.position, 100)}, ${nextStart.toISOString()}, ${nextEnd.toISOString()}, 'Draft',
        ${clean(row.notes, 1000)}, ${input.actor}, NULL
      )
    `;
  }
  return { copied: rows.length };
}

export async function sendOwnerMessage(input: {
  business: Business;
  recipientEmployeeId?: string | null;
  body: string;
  actor: string;
}) {
  await ensureWorkforceSchema();
  const body = clean(input.body, 3000);
  if (!body) throw new Error("Message text is required.");
  if (input.recipientEmployeeId) await employeeForBusiness(input.recipientEmployeeId, input.business);
  await getSql()`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, ${input.recipientEmployeeId || null},
      ${input.recipientEmployeeId ? "Direct" : "Announcement"}, ${body}
    )
  `;
  return { sent: true };
}

export async function sendEmployeeMessage(session: EmployeeSession, input: { recipientEmployeeId?: string | null; body: string }) {
  await ensureWorkforceSchema();
  const employee = await employeeForBusiness(session.employeeId, session.business);
  const body = clean(input.body, 3000);
  if (!body) throw new Error("Message text is required.");
  if (input.recipientEmployeeId) await employeeForBusiness(input.recipientEmployeeId, session.business);
  await getSql()`
    INSERT INTO employee_messages (
      id, business, sender_employee_id, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${session.business}, ${session.employeeId}, ${employee.name},
      ${input.recipientEmployeeId || null}, ${input.recipientEmployeeId ? "Direct" : "Team"}, ${body}
    )
  `;
  return { sent: true };
}

export async function setEmployeeAvailability(session: EmployeeSession, input: {
  weekday: number;
  available: boolean;
  availableFrom?: string;
  availableTo?: string;
  notes?: string;
}) {
  await ensureWorkforceSchema();
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) throw new Error("Choose a valid weekday.");
  await employeeForBusiness(session.employeeId, session.business);
  await getSql()`
    INSERT INTO employee_availability (
      id, employee_id, business, weekday, available, available_from, available_to, notes
    ) VALUES (
      ${crypto.randomUUID()}, ${session.employeeId}, ${session.business}, ${input.weekday}, ${input.available},
      ${clean(input.availableFrom, 10)}, ${clean(input.availableTo, 10)}, ${clean(input.notes, 500)}
    )
    ON CONFLICT (employee_id, weekday) DO UPDATE SET
      available = EXCLUDED.available,
      available_from = EXCLUDED.available_from,
      available_to = EXCLUDED.available_to,
      notes = EXCLUDED.notes,
      updated_at = NOW()
  `;
  return { saved: true };
}

export async function requestTimeOff(session: EmployeeSession, input: { startsOn: string; endsOn: string; reason?: string }) {
  await ensureWorkforceSchema();
  await employeeForBusiness(session.employeeId, session.business);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn)) {
    throw new Error("Choose valid time-off dates.");
  }
  if (input.endsOn < input.startsOn) throw new Error("End date must be on or after the start date.");
  await getSql()`
    INSERT INTO time_off_requests (id, business, employee_id, starts_on, ends_on, reason)
    VALUES (${crypto.randomUUID()}, ${session.business}, ${session.employeeId}, ${input.startsOn}, ${input.endsOn}, ${clean(input.reason, 1000)})
  `;
  return { requested: true };
}

export async function reviewTimeOff(input: { id: string; business: Business; approve: boolean; managerNote?: string; actor: string }) {
  await ensureWorkforceSchema();
  const rows = await getSql()`
    UPDATE time_off_requests SET
      status = ${input.approve ? "Approved" : "Rejected"},
      manager_note = ${clean(input.managerNote, 1000)},
      reviewed_by = ${input.actor}, reviewed_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business} AND status = 'Pending'
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Pending time-off request not found.");
  return { id: rows[0].id };
}

export async function createShiftRequest(session: EmployeeSession, input: {
  requestType: "Claim" | "Offer" | "Swap";
  shiftId: string;
  offeredShiftId?: string | null;
  targetEmployeeId?: string | null;
  note?: string;
}) {
  await ensureWorkforceSchema();
  await employeeForBusiness(session.employeeId, session.business);
  const shifts = await getSql()`
    SELECT * FROM schedule_shifts WHERE id = ${input.shiftId} AND business = ${session.business} LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const shift = shifts[0];
  if (!shift) throw new Error("Shift not found.");
  if (new Date(String(shift.starts_at)).getTime() <= Date.now()) {
    throw new Error("Past shifts cannot be claimed, offered, or swapped.");
  }

  if (input.requestType === "Claim") {
    if (shift.employee_id || shift.status !== "Open") throw new Error("That shift is no longer open.");
  } else if (String(shift.employee_id || "") !== session.employeeId) {
    throw new Error("You can only offer or swap one of your own shifts.");
  }

  let targetEmployeeId = input.targetEmployeeId || null;
  let employeeResponse = targetEmployeeId ? "Pending" : "Not Required";
  if (targetEmployeeId) await employeeForBusiness(targetEmployeeId, session.business);

  if (input.requestType === "Swap") {
    if (!input.offeredShiftId) throw new Error("Choose the other employee's shift for the swap.");
    const offeredRows = await getSql()`
      SELECT employee_id FROM schedule_shifts
      WHERE id = ${input.offeredShiftId}
        AND business = ${session.business}
        AND status = 'Published'
        AND starts_at > NOW()
      LIMIT 1
    ` as unknown as Array<{ employee_id: string | null }>;
    const offered = offeredRows[0];
    if (!offered?.employee_id || offered.employee_id === session.employeeId) throw new Error("Choose another employee's future published shift.");
    targetEmployeeId = offered.employee_id;
    employeeResponse = "Pending";
  }

  await getSql()`
    INSERT INTO shift_requests (
      id, business, request_type, shift_id, offered_shift_id, requester_employee_id,
      target_employee_id, employee_response, note
    ) VALUES (
      ${crypto.randomUUID()}, ${session.business}, ${input.requestType}, ${input.shiftId}, ${input.offeredShiftId || null},
      ${session.employeeId}, ${targetEmployeeId}, ${employeeResponse}, ${clean(input.note, 1000)}
    )
  `;
  return { requested: true };
}

export async function respondToShiftRequest(session: EmployeeSession, input: { id: string; accept: boolean }) {
  await ensureWorkforceSchema();
  const rows = await getSql()`
    UPDATE shift_requests SET employee_response = ${input.accept ? "Accepted" : "Declined"}
    WHERE id = ${input.id}
      AND business = ${session.business}
      AND target_employee_id = ${session.employeeId}
      AND status = 'Pending'
      AND employee_response = 'Pending'
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Pending shift request not found.");
  return { id: rows[0].id };
}

export async function reviewShiftRequest(input: { id: string; business: Business; approve: boolean; managerNote?: string; actor: string }) {
  await ensureWorkforceSchema();
  const rows = await getSql()`
    SELECT * FROM shift_requests WHERE id = ${input.id} AND business = ${input.business} AND status = 'Pending' LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const request = rows[0];
  if (!request) throw new Error("Pending shift request not found.");
  if (input.approve && request.target_employee_id && request.employee_response !== "Accepted") {
    throw new Error("The receiving employee must accept before approval.");
  }

  if (input.approve) {
    if (request.request_type === "Claim") {
      await getSql()`
        UPDATE schedule_shifts SET employee_id = ${String(request.requester_employee_id)}, status = 'Published', updated_at = NOW()
        WHERE id = ${String(request.shift_id)} AND employee_id IS NULL AND status = 'Open'
      `;
    } else if (request.request_type === "Offer") {
      const opened = await getSql()`
        UPDATE schedule_shifts SET employee_id = NULL, status = 'Open', updated_at = NOW()
        WHERE id = ${String(request.shift_id)} AND employee_id = ${String(request.requester_employee_id)}
        RETURNING starts_at, ends_at, position
      ` as unknown as Array<{ starts_at: string | Date; ends_at: string | Date; position: string }>;
      const openShift = opened[0];
      if (openShift) {
        const start = new Date(openShift.starts_at);
        const end = new Date(openShift.ends_at);
        const date = new Intl.DateTimeFormat("en-US", {
          timeZone: TIME_ZONE,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(start);
        const time = new Intl.DateTimeFormat("en-US", {
          timeZone: TIME_ZONE,
          hour: "numeric",
          minute: "2-digit",
        });
        await sendStaffNotification({
          business: input.business,
          actor: input.actor,
          body: `Open shift available: ${date}, ${time.format(start)}-${time.format(end)} · ${clean(openShift.position, 100) || "Shift"}. Request it in Employee Hub.`,
        });
      }
    } else {
      const offeredShiftId = String(request.offered_shift_id || "");
      if (!offeredShiftId) throw new Error("Swap request is missing the second shift.");
      const shiftRows = await getSql()`
        SELECT id, employee_id FROM schedule_shifts
        WHERE id IN (${String(request.shift_id)}, ${offeredShiftId})
        ORDER BY id
      ` as unknown as Array<{ id: string; employee_id: string | null }>;
      const first = shiftRows.find((row) => row.id === String(request.shift_id));
      const second = shiftRows.find((row) => row.id === offeredShiftId);
      if (!first?.employee_id || !second?.employee_id) throw new Error("Both swap shifts must still be assigned.");
      await getSql()`UPDATE schedule_shifts SET employee_id = ${second.employee_id}, updated_at = NOW() WHERE id = ${first.id}`;
      await getSql()`UPDATE schedule_shifts SET employee_id = ${first.employee_id}, updated_at = NOW() WHERE id = ${second.id}`;
    }
  }

  await getSql()`
    UPDATE shift_requests SET
      status = ${input.approve ? "Approved" : "Rejected"},
      manager_note = ${clean(input.managerNote, 1000)},
      reviewed_by = ${input.actor}, reviewed_at = NOW()
    WHERE id = ${input.id}
  `;
  return { id: input.id };
}

export async function requestTimeCorrection(session: EmployeeSession, input: {
  sourceId: string;
  requestedClockIn?: string | null;
  requestedClockOut?: string | null;
  reason: string;
}) {
  await ensureWorkforceSchema();
  const employee = await employeeForBusiness(session.employeeId, session.business);
  const reason = clean(input.reason, 1500);
  if (!reason) throw new Error("Explain what needs to be corrected.");

  if (session.business === "Tiki") {
    const rows = await getSql()`
      SELECT id, clock_in, clock_out FROM time_entries
      WHERE id = ${input.sourceId} AND employee_id = ${session.employeeId} LIMIT 1
    ` as unknown as Array<{ id: string; clock_in: string; clock_out: string | null }>;
    const source = rows[0];
    if (!source) throw new Error("Tiki time entry not found.");
    await getSql()`
      INSERT INTO time_correction_requests (
        id, business, employee_id, source_type, source_id, original_clock_in, original_clock_out,
        requested_clock_in, requested_clock_out, reason
      ) VALUES (
        ${crypto.randomUUID()}, 'Tiki', ${session.employeeId}, 'Corner Ops', ${source.id},
        ${source.clock_in}, ${source.clock_out},
        ${input.requestedClockIn ? dateValue(input.requestedClockIn, "Requested clock-in").toISOString() : source.clock_in},
        ${input.requestedClockOut ? dateValue(input.requestedClockOut, "Requested clock-out").toISOString() : source.clock_out},
        ${reason}
      )
    `;
  } else {
    const rows = await getSql()`
      SELECT id, clock_in, clock_out, reported_hours FROM rezku_shifts
      WHERE id = ${input.sourceId} AND LOWER(employee_name) = LOWER(${employee.name}) LIMIT 1
    ` as unknown as Array<{ id: string; clock_in: string | null; clock_out: string | null; reported_hours: string | number }>;
    const source = rows[0];
    if (!source) throw new Error("Rezku shift not found for this employee.");
    const requestedIn = input.requestedClockIn ? dateValue(input.requestedClockIn, "Requested clock-in") : source.clock_in ? new Date(source.clock_in) : null;
    const requestedOut = input.requestedClockOut ? dateValue(input.requestedClockOut, "Requested clock-out") : source.clock_out ? new Date(source.clock_out) : null;
    const requestedHours = requestedIn && requestedOut ? hoursBetween(requestedIn, requestedOut) : Number(source.reported_hours || 0);
    await getSql()`
      INSERT INTO time_correction_requests (
        id, business, employee_id, source_type, source_id, original_clock_in, original_clock_out,
        requested_clock_in, requested_clock_out, original_reported_hours, requested_reported_hours, reason
      ) VALUES (
        ${crypto.randomUUID()}, 'Corner Deli', ${session.employeeId}, 'Rezku', ${source.id},
        ${source.clock_in}, ${source.clock_out}, ${requestedIn?.toISOString() || null}, ${requestedOut?.toISOString() || null},
        ${Number(source.reported_hours || 0)}, ${requestedHours}, ${reason}
      )
    `;
  }
  return { requested: true };
}

export async function reviewTimeCorrection(input: { id: string; business: Business; approve: boolean; managerNote?: string; actor: string }) {
  await ensureWorkforceSchema();
  const rows = await getSql()`
    SELECT * FROM time_correction_requests
    WHERE id = ${input.id} AND business = ${input.business} AND status = 'Pending'
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const request = rows[0];
  if (!request) throw new Error("Pending time correction not found.");

  if (input.approve) {
    if (request.source_type === "Corner Ops") {
      await getSql()`
        UPDATE time_entries SET
          clock_in = COALESCE(${request.requested_clock_in ? String(request.requested_clock_in) : null}, clock_in),
          clock_out = ${request.requested_clock_out ? String(request.requested_clock_out) : null},
          status = 'Corrected',
          notes = CONCAT_WS(' | ', NULLIF(notes, ''), ${`Correction approved by ${input.actor}: ${clean(request.reason, 500)}`}),
          updated_at = NOW()
        WHERE id = ${String(request.source_id)}
      `;
    } else {
      await getSql()`
        UPDATE rezku_shifts SET
          clock_in = ${request.requested_clock_in ? String(request.requested_clock_in) : null},
          clock_out = ${request.requested_clock_out ? String(request.requested_clock_out) : null},
          reported_hours = ${Number(request.requested_reported_hours || 0)}
        WHERE id = ${String(request.source_id)}
      `;
    }
  }

  await getSql()`
    UPDATE time_correction_requests SET
      status = ${input.approve ? "Approved" : "Rejected"},
      manager_note = ${clean(input.managerNote, 1000)},
      reviewed_by = ${input.actor}, reviewed_at = NOW()
    WHERE id = ${input.id}
  `;
  return { id: input.id };
}

export function localDateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

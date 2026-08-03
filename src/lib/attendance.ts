import { createHash } from "node:crypto";
import { Resend } from "resend";
import { getSql } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import type { EmployeeSession } from "@/lib/employee-auth";
import type { Business } from "@/lib/types";
import { ensureWorkforceSchema } from "@/lib/workforce";

const TIME_ZONE = "America/New_York";
let attendanceSchemaPromise: Promise<void> | null = null;

type MissedShiftRow = {
  id: string;
  shift_id: string;
  business: Business;
  employee_id: string;
  employee_name: string;
  employee_email: string;
  position: string;
  scheduled_start: string;
  scheduled_end: string;
  correction_start: string | null;
  correction_end: string | null;
  employee_note: string;
  submission_channel: string;
  status: string;
  reply_token: string;
  notified_at: string | null;
  notification_error: string;
  detected_at: string;
  reviewed_by: string;
  reviewed_at: string | null;
  manager_note: string;
};

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function emailAddress(value: string): string {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
}

function getOffsetMilliseconds(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return represented - date.getTime();
}

function zonedDateToUtc(dateText: string, hour: number, minute: number): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  let timestamp = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let index = 0; index < 2; index += 1) {
    timestamp = Date.UTC(year, month - 1, day, hour, minute, 0) - getOffsetMilliseconds(new Date(timestamp));
  }
  return new Date(timestamp);
}

function parseEmployeeDateTime(value: string): Date | null {
  const direct = new Date(value);
  if (/T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) && !Number.isNaN(direct.getTime())) return direct;
  const match = value.trim().match(/(\d{4}-\d{2}-\d{2})[ T]+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return Number.isNaN(direct.getTime()) ? null : direct;
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  const meridiem = match[4]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return zonedDateToUtc(match[1], hour, minute);
}

function formatLocal(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function localTemplate(value: string): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${values.dayPeriod}`;
}

export function ensureAttendanceSchema(): Promise<void> {
  if (!attendanceSchemaPromise) {
    attendanceSchemaPromise = (async () => {
      await ensureEmployeeDirectorySchema();
      await ensureWorkforceSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS missed_shift_cases (
          id UUID PRIMARY KEY,
          shift_id UUID NOT NULL UNIQUE REFERENCES schedule_shifts(id) ON DELETE CASCADE,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          employee_name TEXT NOT NULL,
          employee_email TEXT NOT NULL DEFAULT '',
          position TEXT NOT NULL DEFAULT '',
          scheduled_start TIMESTAMPTZ NOT NULL,
          scheduled_end TIMESTAMPTZ NOT NULL,
          correction_start TIMESTAMPTZ,
          correction_end TIMESTAMPTZ,
          employee_note TEXT NOT NULL DEFAULT '',
          submission_channel TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'Awaiting Reply' CHECK (status IN ('Awaiting Reply', 'Submitted', 'Approved', 'Rejected', 'Resolved')),
          reply_token TEXT NOT NULL UNIQUE,
          notified_at TIMESTAMPTZ,
          notification_error TEXT NOT NULL DEFAULT '',
          detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_by TEXT NOT NULL DEFAULT '',
          reviewed_at TIMESTAMPTZ,
          manager_note TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS missed_shift_business_status_idx ON missed_shift_cases (business, status, scheduled_start DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS missed_shift_employee_idx ON missed_shift_cases (employee_id, scheduled_start DESC)`;
    })().catch((error) => {
      attendanceSchemaPromise = null;
      throw error;
    });
  }
  return attendanceSchemaPromise;
}

async function actualRecordExists(input: {
  business: Business;
  employeeId: string;
  employeeName: string;
  start: string;
  end: string;
}) {
  const sql = getSql();
  if (input.business === "Tiki") {
    const rows = await sql`
      SELECT id FROM time_entries
      WHERE employee_id = ${input.employeeId}
        AND clock_in < ${input.end}
        AND COALESCE(clock_out, NOW()) > ${input.start}
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    return Boolean(rows[0]);
  }
  const rows = await sql`
    SELECT id FROM rezku_shifts
    WHERE LOWER(BTRIM(employee_name)) = LOWER(BTRIM(${input.employeeName}))
      AND clock_in < ${input.end}
      AND COALESCE(clock_out, clock_in + INTERVAL '1 minute') > ${input.start}
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

async function reconcileCases() {
  const rows = await getSql()`
    SELECT * FROM missed_shift_cases
    WHERE status IN ('Awaiting Reply', 'Submitted')
      AND scheduled_start >= NOW() - INTERVAL '30 days'
  ` as unknown as MissedShiftRow[];
  let resolved = 0;
  for (const row of rows) {
    if (await actualRecordExists({
      business: row.business,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      start: row.scheduled_start,
      end: row.scheduled_end,
    })) {
      await getSql()`
        UPDATE missed_shift_cases
        SET status = 'Resolved', manager_note = 'A matching time record arrived after the missed-shift case was created.', reviewed_at = NOW()
        WHERE id = ${row.id}
      `;
      resolved += 1;
    }
  }
  return resolved;
}

async function sendMissedShiftEmail(row: MissedShiftRow) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() || process.env.ALERT_FROM_EMAIL?.trim();
  const appUrl = (process.env.EMPLOYEE_APP_URL?.trim() || process.env.APP_URL?.trim() || "").replace(/\/$/, "");
  const replyDomain = process.env.ATTENDANCE_REPLY_DOMAIN?.trim().toLowerCase();
  if (!row.employee_email) return { sent: false, reason: "Employee email is missing." };
  if (!apiKey || !from) return { sent: false, reason: "Employee email delivery is not configured." };

  const portalLink = appUrl ? `${appUrl}/employee/attendance?case=${encodeURIComponent(row.id)}` : "";
  const replyTo = replyDomain ? `attendance+${row.reply_token}@${replyDomain}` : undefined;
  const text = [
    `Hi ${row.employee_name.split(/\s+/)[0]},`,
    "",
    `Corner Ops could not find a time record matching your scheduled ${row.position || "shift"}:`,
    `${formatLocal(row.scheduled_start)} to ${formatLocal(row.scheduled_end)}`,
    "",
    "You can correct this in the Employee Hub, or reply to this email using the format below:",
    `CLOCK IN: ${localTemplate(row.scheduled_start)}`,
    `CLOCK OUT: ${localTemplate(row.scheduled_end)}`,
    "REASON: Explain what happened or which punch is missing.",
    "",
    portalLink ? `Employee Hub: ${portalLink}` : "Sign in to the Employee Hub to submit the correction.",
    "",
    "Your correction will remain pending until management approves it.",
  ].join("\n");

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from,
    to: row.employee_email,
    replyTo,
    subject: `${row.business} missing shift record: ${new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric" }).format(new Date(row.scheduled_start))}`,
    text,
  });
  if (result.error) throw new Error(result.error.message);
  return { sent: true, id: result.data?.id || null };
}

export async function detectMissedShifts() {
  await ensureAttendanceSchema();
  const resolved = await reconcileCases();
  const rows = await getSql()`
    SELECT s.id AS shift_id, s.business, s.employee_id, s.position, s.starts_at, s.ends_at,
      e.name AS employee_name, e.email AS employee_email
    FROM schedule_shifts s
    JOIN employees e ON e.id = s.employee_id
    LEFT JOIN missed_shift_cases c ON c.shift_id = s.id
    WHERE c.id IS NULL
      AND s.status = 'Published'
      AND s.employee_id IS NOT NULL
      AND s.ends_at >= NOW() - INTERVAL '96 hours'
      AND (
        (s.business = 'Tiki' AND s.ends_at <= NOW() - INTERVAL '2 hours')
        OR
        (s.business = 'Corner Deli' AND s.ends_at <= NOW() - INTERVAL '30 hours')
      )
    ORDER BY s.ends_at
  ` as unknown as Array<{
    shift_id: string;
    business: Business;
    employee_id: string;
    position: string;
    starts_at: string;
    ends_at: string;
    employee_name: string;
    employee_email: string;
  }>;

  let created = 0;
  let emailed = 0;
  let emailSkipped = 0;
  const errors: string[] = [];
  for (const shift of rows) {
    const exists = await actualRecordExists({
      business: shift.business,
      employeeId: shift.employee_id,
      employeeName: shift.employee_name,
      start: shift.starts_at,
      end: shift.ends_at,
    });
    if (exists) continue;

    const inserted = await getSql()`
      INSERT INTO missed_shift_cases (
        id, shift_id, business, employee_id, employee_name, employee_email, position,
        scheduled_start, scheduled_end, reply_token
      ) VALUES (
        ${crypto.randomUUID()}, ${shift.shift_id}, ${shift.business}, ${shift.employee_id},
        ${shift.employee_name}, ${clean(shift.employee_email, 255).toLowerCase()}, ${clean(shift.position, 100)},
        ${shift.starts_at}, ${shift.ends_at}, ${crypto.randomUUID().replaceAll("-", "")}
      )
      ON CONFLICT (shift_id) DO NOTHING
      RETURNING *
    ` as unknown as MissedShiftRow[];
    const row = inserted[0];
    if (!row) continue;
    created += 1;
    try {
      const delivery = await sendMissedShiftEmail(row);
      if (delivery.sent) {
        emailed += 1;
        await getSql()`UPDATE missed_shift_cases SET notified_at = NOW(), notification_error = '' WHERE id = ${row.id}`;
      } else {
        emailSkipped += 1;
        await getSql()`UPDATE missed_shift_cases SET notification_error = ${delivery.reason || "Email skipped."} WHERE id = ${row.id}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${row.employee_name}: ${message}`);
      await getSql()`UPDATE missed_shift_cases SET notification_error = ${message} WHERE id = ${row.id}`;
    }
  }
  return { resolved, checked: rows.length, created, emailed, emailSkipped, errors };
}

function mapCase(row: MissedShiftRow) {
  return {
    id: row.id,
    shiftId: row.shift_id,
    business: row.business,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeEmail: row.employee_email,
    position: row.position,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    correctionStart: row.correction_start,
    correctionEnd: row.correction_end,
    employeeNote: row.employee_note,
    submissionChannel: row.submission_channel,
    status: row.status,
    notifiedAt: row.notified_at,
    notificationError: row.notification_error,
    detectedAt: row.detected_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    managerNote: row.manager_note,
  };
}

export async function employeeAttendanceCases(session: EmployeeSession) {
  await ensureAttendanceSchema();
  const rows = await getSql()`
    SELECT * FROM missed_shift_cases
    WHERE employee_id = ${session.employeeId}
      AND business = ${session.business}
      AND scheduled_start >= NOW() - INTERVAL '180 days'
    ORDER BY CASE WHEN status IN ('Awaiting Reply', 'Submitted') THEN 0 ELSE 1 END, scheduled_start DESC
  ` as unknown as MissedShiftRow[];
  return { business: session.business, employeeId: session.employeeId, cases: rows.map(mapCase) };
}

export async function submitEmployeeAttendanceCase(session: EmployeeSession, input: {
  id: string;
  correctionStart: string;
  correctionEnd: string;
  reason: string;
}) {
  await ensureAttendanceSchema();
  const start = parseEmployeeDateTime(input.correctionStart);
  const end = parseEmployeeDateTime(input.correctionEnd);
  const reason = clean(input.reason, 3000);
  if (!start || !end || end <= start) throw new Error("Enter a valid clock-in and clock-out.");
  if (!reason) throw new Error("Explain why the time record is missing or incorrect.");
  const rows = await getSql()`
    UPDATE missed_shift_cases SET
      correction_start = ${start.toISOString()},
      correction_end = ${end.toISOString()},
      employee_note = ${reason},
      submission_channel = 'Employee Hub',
      status = 'Submitted'
    WHERE id = ${input.id}
      AND employee_id = ${session.employeeId}
      AND business = ${session.business}
      AND status IN ('Awaiting Reply', 'Submitted', 'Rejected')
    RETURNING *
  ` as unknown as MissedShiftRow[];
  if (!rows[0]) throw new Error("That missed-shift case is no longer available for correction.");
  return mapCase(rows[0]);
}

function replyToken(recipients: string[]): string {
  for (const recipient of recipients) {
    const match = recipient.toLowerCase().match(/attendance\+([a-z0-9]+)@/);
    if (match) return match[1];
  }
  return "";
}

function cleanReplyBody(value: string): string {
  const lines = value.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:$/i.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    kept.push(line);
  }
  return clean(kept.join("\n").trim(), 5000);
}

function replyField(body: string, label: string): string {
  const match = body.match(new RegExp(`^${label}\\s*:\\s*(.+)$`, "im"));
  return clean(match?.[1] || "", 120);
}

export async function processAttendanceReply(input: {
  recipients: string[];
  from: string;
  text: string;
  subject?: string;
}) {
  await ensureAttendanceSchema();
  const token = replyToken(input.recipients);
  if (!token) return { handled: false };
  const rows = await getSql()`
    SELECT * FROM missed_shift_cases WHERE reply_token = ${token} LIMIT 1
  ` as unknown as MissedShiftRow[];
  const row = rows[0];
  if (!row) return { handled: true, accepted: false, reason: "Attendance reply token was not recognized." };
  const sender = emailAddress(input.from);
  if (!sender || !row.employee_email || sender !== row.employee_email.toLowerCase()) {
    return { handled: true, accepted: false, reason: "Reply sender did not match the employee email on the case." };
  }
  if (!['Awaiting Reply', 'Submitted', 'Rejected'].includes(row.status)) {
    return { handled: true, accepted: false, reason: `Case is already ${row.status.toLowerCase()}.` };
  }

  const body = cleanReplyBody(input.text);
  const clockInText = replyField(body, "CLOCK IN");
  const clockOutText = replyField(body, "CLOCK OUT");
  const reasonText = replyField(body, "REASON");
  const start = clockInText ? parseEmployeeDateTime(clockInText) : new Date(row.scheduled_start);
  const end = clockOutText ? parseEmployeeDateTime(clockOutText) : new Date(row.scheduled_end);
  if (!start || !end || end <= start) {
    return { handled: true, accepted: false, reason: "The replied clock-in or clock-out could not be understood." };
  }
  const note = clean(reasonText || body || "Correction submitted by email reply.", 3000);
  await getSql()`
    UPDATE missed_shift_cases SET
      correction_start = ${start.toISOString()},
      correction_end = ${end.toISOString()},
      employee_note = ${note},
      submission_channel = 'Email reply',
      status = 'Submitted'
    WHERE id = ${row.id}
  `;
  return { handled: true, accepted: true, caseId: row.id };
}

export async function attendanceAdminDashboard(business: Business) {
  await ensureAttendanceSchema();
  const rows = await getSql()`
    SELECT * FROM missed_shift_cases
    WHERE business = ${business}
      AND scheduled_start >= NOW() - INTERVAL '180 days'
    ORDER BY CASE status WHEN 'Submitted' THEN 0 WHEN 'Awaiting Reply' THEN 1 ELSE 2 END, scheduled_start DESC
  ` as unknown as MissedShiftRow[];
  return {
    business,
    counts: {
      awaitingReply: rows.filter((row) => row.status === "Awaiting Reply").length,
      submitted: rows.filter((row) => row.status === "Submitted").length,
      approved: rows.filter((row) => row.status === "Approved").length,
      unresolvedEmail: rows.filter((row) => row.notification_error).length,
    },
    cases: rows.map(mapCase),
  };
}

async function createApprovedTimeRecord(row: MissedShiftRow, actor: string) {
  const start = row.correction_start || row.scheduled_start;
  const end = row.correction_end || row.scheduled_end;
  if (await actualRecordExists({
    business: row.business,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    start,
    end,
  })) return { created: false, reason: "A matching time record already exists." };

  if (row.business === "Tiki") {
    const employees = await getSql()`
      SELECT role_group FROM employees WHERE id = ${row.employee_id} LIMIT 1
    ` as unknown as Array<{ role_group: "Driver" | "In-House" | "Ignore" }>;
    await getSql()`
      INSERT INTO time_entries (
        id, business, employee_id, employee_name, position, role_group,
        clock_in, clock_out, source, status, notes
      ) VALUES (
        ${crypto.randomUUID()}, 'Tiki', ${row.employee_id}, ${row.employee_name}, ${row.position},
        ${employees[0]?.role_group || "In-House"}, ${start}, ${end}, 'Attendance Correction', 'Corrected',
        ${`Approved by ${actor}. ${row.employee_note}`}
      )
    `;
    return { created: true, source: "Corner Ops time entry" };
  }

  const batchId = crypto.randomUUID();
  await getSql()`
    INSERT INTO rezku_import_batches (id, report_type, file_name, row_count, imported_by)
    VALUES (${batchId}, 'shifts', ${`attendance-correction-${row.id}.json`}, 1, ${actor})
  `;
  const sourceKey = createHash("sha256").update(`attendance:${row.id}`).digest("hex");
  const employees = await getSql()`
    SELECT role_group FROM employees WHERE id = ${row.employee_id} LIMIT 1
  ` as unknown as Array<{ role_group: "Driver" | "In-House" | "Ignore" }>;
  const hours = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000);
  await getSql()`
    INSERT INTO rezku_shifts (
      id, source_key, batch_id, employee_name, position, role_group,
      clock_in, clock_out, reported_hours, raw
    ) VALUES (
      ${crypto.randomUUID()}, ${sourceKey}, ${batchId}, ${row.employee_name}, ${row.position},
      ${employees[0]?.role_group || "In-House"}, ${start}, ${end}, ${hours},
      ${JSON.stringify({ source: "Attendance Correction", caseId: row.id, approvedBy: actor, note: row.employee_note })}::jsonb
    )
    ON CONFLICT (source_key) DO NOTHING
  `;
  return { created: true, source: "Manual Deli labor record" };
}

export async function reviewAttendanceCase(input: {
  id: string;
  business: Business;
  approve: boolean;
  actor: string;
  managerNote?: string;
}) {
  await ensureAttendanceSchema();
  const rows = await getSql()`
    SELECT * FROM missed_shift_cases
    WHERE id = ${input.id} AND business = ${input.business} AND status = 'Submitted'
    LIMIT 1
  ` as unknown as MissedShiftRow[];
  const row = rows[0];
  if (!row) throw new Error("Submitted attendance correction not found.");
  const creation = input.approve ? await createApprovedTimeRecord(row, input.actor) : null;
  await getSql()`
    UPDATE missed_shift_cases SET
      status = ${input.approve ? "Approved" : "Rejected"},
      reviewed_by = ${input.actor},
      reviewed_at = NOW(),
      manager_note = ${clean(input.managerNote, 2000)}
    WHERE id = ${input.id}
  `;
  return { id: input.id, status: input.approve ? "Approved" : "Rejected", timeRecord: creation };
}

import { Resend } from "resend";
import { getSql } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import type { Business } from "@/lib/types";
import { ensureWorkforceSchema } from "@/lib/workforce";

const TIME_ZONE = "America/New_York";
let notificationSchemaPromise: Promise<void> | null = null;

type EmployeeContact = {
  id: string;
  name: string;
  email: string;
};

type ScheduleShiftRow = {
  id: string;
  employee_id: string | null;
  employee_name: string | null;
  position: string;
  starts_at: string;
  ends_at: string;
  notes: string;
  status: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function validWeekStart(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid schedule week.");
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDay() !== 1) throw new Error("Schedule weeks must start on Monday.");
  return value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

function shiftLabel(shift: ScheduleShiftRow): string {
  const start = new Date(shift.starts_at);
  const end = new Date(shift.ends_at);
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
  const notes = clean(shift.notes, 1000);
  return `${date}, ${time.format(start)}–${time.format(end)} — ${clean(shift.position, 100) || "Shift"}${notes ? `\n  ${notes}` : ""}`;
}

function employeeHubUrl(): string {
  const configured = process.env.EMPLOYEE_APP_URL?.trim() || process.env.APP_URL?.trim();
  if (configured) return `${configured.replace(/\/$/, "")}/employee`;
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  return vercelUrl ? `https://${vercelUrl.replace(/\/$/, "")}/employee` : "";
}

function emailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() || process.env.ALERT_FROM_EMAIL?.trim();
  return apiKey && from ? { resend: new Resend(apiKey), from } : null;
}

async function activeContacts(business: Business): Promise<EmployeeContact[]> {
  await ensureEmployeeDirectorySchema();
  return await getSql()`
    SELECT id, name, email
    FROM employees
    WHERE business = ${business} AND active = TRUE
    ORDER BY name
  ` as unknown as EmployeeContact[];
}

async function deliverEmails(input: {
  business: Business;
  recipients: EmployeeContact[];
  subject: (employee: EmployeeContact) => string;
  text: (employee: EmployeeContact) => string;
}) {
  const configured = emailConfiguration();
  const missingEmail = input.recipients.filter((employee) => !clean(employee.email, 255));
  const deliverable = input.recipients.filter((employee) => clean(employee.email, 255));
  if (!configured) {
    return {
      configured: false,
      sent: 0,
      failed: 0,
      missingEmail: missingEmail.length,
      skipped: deliverable.length,
      failures: [] as Array<{ employeeId: string; message: string }>,
    };
  }

  let sent = 0;
  const failures: Array<{ employeeId: string; message: string }> = [];
  for (const employee of deliverable) {
    try {
      const result = await configured.resend.emails.send({
        from: configured.from,
        to: clean(employee.email, 255),
        subject: input.subject(employee),
        text: input.text(employee),
      });
      if (result.error) throw new Error(result.error.message);
      sent += 1;
    } catch (error) {
      failures.push({
        employeeId: employee.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    configured: true,
    sent,
    failed: failures.length,
    missingEmail: missingEmail.length,
    skipped: 0,
    failures,
  };
}

export function ensureStaffNotificationSchema(): Promise<void> {
  if (!notificationSchemaPromise) {
    notificationSchemaPromise = (async () => {
      await ensureWorkforceSchema();
      await ensureEmployeeDirectorySchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS schedule_publications (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          week_start DATE NOT NULL,
          week_end DATE NOT NULL,
          published_by TEXT NOT NULL,
          shift_count INTEGER NOT NULL DEFAULT 0,
          active_employee_count INTEGER NOT NULL DEFAULT 0,
          email_sent_count INTEGER NOT NULL DEFAULT 0,
          email_missing_count INTEGER NOT NULL DEFAULT 0,
          email_failed_count INTEGER NOT NULL DEFAULT 0,
          email_configured BOOLEAN NOT NULL DEFAULT FALSE,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS schedule_publications_business_week_idx
        ON schedule_publications (business, week_start, published_at DESC)
      `;
    })().catch((error) => {
      notificationSchemaPromise = null;
      throw error;
    });
  }
  return notificationSchemaPromise;
}

export async function createScheduleDraft(input: {
  business: Business;
  employeeId?: string | null;
  position: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
  actor: string;
}) {
  await ensureStaffNotificationSchema();
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Shift date or time is invalid.");
  if (end <= start) throw new Error("Shift end must be after the start.");
  const position = clean(input.position, 100);
  if (!position) throw new Error("Shift position is required.");

  if (input.employeeId) {
    const employee = await getSql()`
      SELECT id FROM employees
      WHERE id = ${input.employeeId} AND business = ${input.business} AND active = TRUE
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (!employee[0]) throw new Error("Employee is not active for this location.");

    const overlap = await getSql()`
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
  await getSql()`
    INSERT INTO schedule_shifts (
      id, business, employee_id, position, starts_at, ends_at, status,
      notes, created_by, published_at
    ) VALUES (
      ${id}, ${input.business}, ${input.employeeId || null}, ${position},
      ${start.toISOString()}, ${end.toISOString()}, 'Draft', ${clean(input.notes, 1000)},
      ${input.actor}, NULL
    )
  `;
  return { id, status: "Draft" };
}

export async function publishScheduleWeek(input: {
  business: Business;
  weekStart: string;
  actor: string;
}) {
  await ensureStaffNotificationSchema();
  const weekStart = validWeekStart(input.weekStart);
  const weekEnd = addDays(weekStart, 6);
  const sql = getSql();

  const existing = await sql`
    SELECT id FROM schedule_shifts
    WHERE business = ${input.business}
      AND starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND status <> 'Cancelled'
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!existing[0]) throw new Error("There are no shifts to publish for this week.");

  await sql`
    UPDATE schedule_shifts SET
      status = CASE WHEN employee_id IS NULL THEN 'Open' ELSE 'Published' END,
      published_at = NOW(),
      updated_at = NOW()
    WHERE business = ${input.business}
      AND starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND status <> 'Cancelled'
  `;

  const shifts = await sql`
    SELECT s.id, s.employee_id, e.name AS employee_name, s.position,
      s.starts_at, s.ends_at, s.notes, s.status
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
    ORDER BY s.starts_at, e.name
  ` as unknown as ScheduleShiftRow[];

  const contacts = await activeContacts(input.business);
  const openShifts = shifts.filter((shift) => !shift.employee_id);
  const rangeLabel = `${dateLabel(weekStart)} through ${dateLabel(weekEnd)}`;
  const hubUrl = employeeHubUrl();

  await sql`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, NULL, 'Announcement',
      ${`${input.business} schedule published for ${rangeLabel}. Open Employee Hub to review your shifts${openShifts.length ? ` and ${openShifts.length} open shift${openShifts.length === 1 ? "" : "s"}` : ""}.`}
    )
  `;

  const delivery = await deliverEmails({
    business: input.business,
    recipients: contacts,
    subject: () => `${input.business} schedule: ${dateLabel(weekStart)}–${dateLabel(weekEnd)}`,
    text: (employee) => {
      const employeeShifts = shifts.filter((shift) => shift.employee_id === employee.id);
      const schedule = employeeShifts.length
        ? employeeShifts.map((shift) => `- ${shiftLabel(shift)}`).join("\n")
        : "- You are not currently scheduled for this week.";
      return [
        `Hi ${clean(employee.name, 120).split(/\s+/)[0] || "there"},`,
        "",
        `The ${input.business} schedule for ${rangeLabel} has been published.`,
        "",
        "Your schedule:",
        schedule,
        openShifts.length ? `\nThere ${openShifts.length === 1 ? "is" : "are"} ${openShifts.length} open shift${openShifts.length === 1 ? "" : "s"} available in Employee Hub.` : "",
        hubUrl ? `\nView the schedule: ${hubUrl}` : "",
        "",
        "This email was sent by Corner Ops.",
      ].filter(Boolean).join("\n");
    },
  });

  const publicationId = crypto.randomUUID();
  await sql`
    INSERT INTO schedule_publications (
      id, business, week_start, week_end, published_by, shift_count,
      active_employee_count, email_sent_count, email_missing_count,
      email_failed_count, email_configured, details
    ) VALUES (
      ${publicationId}, ${input.business}, ${weekStart}, ${weekEnd}, ${input.actor}, ${shifts.length},
      ${contacts.length}, ${delivery.sent}, ${delivery.missingEmail}, ${delivery.failed},
      ${delivery.configured}, ${JSON.stringify({ failures: delivery.failures, skipped: delivery.skipped })}::jsonb
    )
  `;

  return {
    publicationId,
    weekStart,
    weekEnd,
    publishedShifts: shifts.length,
    activeEmployees: contacts.length,
    openShifts: openShifts.length,
    email: delivery,
  };
}

export async function sendStaffNotification(input: {
  business: Business;
  recipientEmployeeId?: string | null;
  body: string;
  actor: string;
}) {
  await ensureStaffNotificationSchema();
  const body = clean(input.body, 3000);
  if (!body) throw new Error("Message text is required.");
  const contacts = await activeContacts(input.business);
  const recipients = input.recipientEmployeeId
    ? contacts.filter((employee) => employee.id === input.recipientEmployeeId)
    : contacts;
  if (input.recipientEmployeeId && !recipients[0]) throw new Error("Employee is not active for this location.");

  await getSql()`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, ${input.recipientEmployeeId || null},
      ${input.recipientEmployeeId ? "Direct" : "Announcement"}, ${body}
    )
  `;

  const hubUrl = employeeHubUrl();
  const delivery = await deliverEmails({
    business: input.business,
    recipients,
    subject: () => `${input.business} staff message`,
    text: (employee) => [
      `Hi ${clean(employee.name, 120).split(/\s+/)[0] || "there"},`,
      "",
      body,
      hubUrl ? `\nOpen Employee Hub: ${hubUrl}` : "",
      "",
      `Sent by ${input.actor} through Corner Ops.`,
    ].filter(Boolean).join("\n"),
  });

  return {
    sent: true,
    recipients: recipients.length,
    email: delivery,
  };
}

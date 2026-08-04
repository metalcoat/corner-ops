import { Resend } from "resend";
import { getSql } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { ensureStaffNotificationSchema } from "@/lib/staff-notifications";
import { deliverSms, type SmsRecipient } from "@/lib/sms-notifications";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

type EmployeeContact = SmsRecipient & {
  email: string;
};

type ScheduleShiftRow = {
  id: string;
  employee_id: string | null;
  employee_name: string | null;
  position: string;
  starts_at: string;
  ends_at: string;
  meal_break_start: string | null;
  meal_break_minutes: number;
  extra_meal_break_start: string | null;
  extra_meal_break_minutes: number;
  notes: string;
  status: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
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

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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
  const meals = [
    shift.meal_break_start && shift.meal_break_minutes
      ? `meal ${timeLabel(shift.meal_break_start)} (${shift.meal_break_minutes}m)`
      : "",
    shift.extra_meal_break_start && shift.extra_meal_break_minutes
      ? `extra meal ${timeLabel(shift.extra_meal_break_start)} (${shift.extra_meal_break_minutes}m)`
      : "",
  ].filter(Boolean);
  const notes = clean(shift.notes, 1000);
  return `${date}, ${time.format(start)}–${time.format(end)} — ${clean(shift.position, 100) || "Shift"}${meals.length ? ` [${meals.join(", ")}]` : ""}${notes ? `\n  ${notes}` : ""}`;
}

function employeeHubUrl(business: Business): string {
  const configured = process.env.EMPLOYEE_APP_URL?.trim() || process.env.APP_URL?.trim();
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  const root = configured
    ? configured.replace(/\/$/, "")
    : vercelUrl
      ? `https://${vercelUrl.replace(/\/$/, "")}`
      : "";
  if (!root) return "";
  const hub = root.endsWith("/employee") ? root : `${root}/employee`;
  return `${hub}?business=${encodeURIComponent(business)}`;
}

function pinInstruction(business: Business): string {
  return business === "Tiki"
    ? "Sign in with the same 5-digit PIN you normally use to clock in at Tiki."
    : "Sign in with your normal 4-digit Rezku PIN for Corner Deli.";
}

function emailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() || process.env.ALERT_FROM_EMAIL?.trim();
  return apiKey && from ? { resend: new Resend(apiKey), from } : null;
}

async function activeContacts(business: Business): Promise<EmployeeContact[]> {
  await ensureEmployeeDirectorySchema();
  const rows = await getSql()`
    SELECT id, name, email, phone, sms_opt_in
    FROM employees
    WHERE business = ${business} AND active = TRUE
    ORDER BY name
  ` as unknown as Array<{ id: string; name: string; email: string; phone: string; sms_opt_in: boolean }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email || "",
    phone: row.phone || "",
    smsOptIn: Boolean(row.sms_opt_in),
  }));
}

async function deliverEmails(input: {
  recipients: EmployeeContact[];
  subject: string;
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
        subject: input.subject,
        text: input.text(employee),
      });
      if (result.error) throw new Error(result.error.message);
      sent += 1;
    } catch (error) {
      failures.push({ employeeId: employee.id, message: error instanceof Error ? error.message : String(error) });
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

export async function publishBusinessScheduleWeek(input: {
  business: Business;
  weekStart: string;
  actor: string;
}) {
  await ensureStaffNotificationSchema();
  const weekEnd = addDays(input.weekStart, 6);
  const sql = getSql();

  const existing = await sql`
    SELECT id FROM schedule_shifts
    WHERE business = ${input.business}
      AND starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND status <> 'Cancelled'
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!existing[0]) throw new Error("There are no shifts to publish for this week.");

  const priorPublication = await sql`
    SELECT id FROM schedule_publications
    WHERE business = ${input.business} AND week_start = ${input.weekStart}
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  const scheduleVerb = priorPublication[0] ? "updated" : "published";

  await sql`
    UPDATE schedule_shifts SET
      status = CASE WHEN employee_id IS NULL THEN 'Open' ELSE 'Published' END,
      published_at = NOW(), updated_at = NOW()
    WHERE business = ${input.business}
      AND starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND status <> 'Cancelled'
  `;

  const shifts = await sql`
    SELECT s.id, s.employee_id, e.name AS employee_name, s.position,
      s.starts_at, s.ends_at, s.meal_break_start, s.meal_break_minutes,
      s.extra_meal_break_start, s.extra_meal_break_minutes, s.notes, s.status
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
    ORDER BY s.starts_at, e.name
  ` as unknown as ScheduleShiftRow[];

  const contacts = await activeContacts(input.business);
  const openShifts = shifts.filter((shift) => !shift.employee_id);
  const rangeLabel = `${dateLabel(input.weekStart)} through ${dateLabel(weekEnd)}`;
  const hubUrl = employeeHubUrl(input.business);
  const accessInstruction = pinInstruction(input.business);
  const accessText = hubUrl ? `Employee Portal: ${hubUrl} ${accessInstruction}` : accessInstruction;

  await sql`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, NULL, 'Announcement',
      ${`${input.business} schedule ${scheduleVerb} for ${rangeLabel}. ${accessText}${openShifts.length ? ` There ${openShifts.length === 1 ? "is" : "are"} ${openShifts.length} open shift${openShifts.length === 1 ? "" : "s"}.` : ""}`}
    )
  `;

  const email = await deliverEmails({
    recipients: contacts,
    subject: `${input.business} schedule ${scheduleVerb}: ${dateLabel(input.weekStart)}–${dateLabel(weekEnd)}`,
    text: (employee) => {
      const employeeShifts = shifts.filter((shift) => shift.employee_id === employee.id);
      const schedule = employeeShifts.length
        ? employeeShifts.map((shift) => `- ${shiftLabel(shift)}`).join("\n")
        : "- You are not currently scheduled for this week.";
      return [
        `Hi ${clean(employee.name, 120).split(/\s+/)[0] || "there"},`,
        "",
        `The ${input.business} schedule for ${rangeLabel} was ${scheduleVerb}.`,
        "",
        "Your schedule:",
        schedule,
        openShifts.length ? `\nThere ${openShifts.length === 1 ? "is" : "are"} ${openShifts.length} open shift${openShifts.length === 1 ? "" : "s"} in the Employee Portal.` : "",
        hubUrl ? `\nOpen the ${input.business} Employee Portal: ${hubUrl}` : "",
        accessInstruction,
        "",
        "This email was sent by Corner Ops.",
      ].filter(Boolean).join("\n");
    },
  });

  const sms = await deliverSms({
    recipients: contacts,
    text: () => [
      `${input.business} schedule ${scheduleVerb} for ${dateLabel(input.weekStart)}-${dateLabel(weekEnd)}.`,
      hubUrl ? `Portal: ${hubUrl}` : "Open Employee Hub to review.",
      accessInstruction,
      "Reply STOP to opt out.",
    ].join(" "),
  });

  const publicationId = crypto.randomUUID();
  await sql`
    INSERT INTO schedule_publications (
      id, business, week_start, week_end, published_by, shift_count,
      active_employee_count, email_sent_count, email_missing_count,
      email_failed_count, email_configured, sms_sent_count, sms_missing_count,
      sms_failed_count, sms_configured, details
    ) VALUES (
      ${publicationId}, ${input.business}, ${input.weekStart}, ${weekEnd}, ${input.actor}, ${shifts.length},
      ${contacts.length}, ${email.sent}, ${email.missingEmail}, ${email.failed}, ${email.configured},
      ${sms.sent}, ${sms.missingPhone}, ${sms.failed}, ${sms.configured},
      ${JSON.stringify({ emailFailures: email.failures, emailSkipped: email.skipped, smsFailures: sms.failures, smsNotOptedIn: sms.notOptedIn, smsSkipped: sms.skipped, hubUrl, pinInstruction: accessInstruction })}::jsonb
    )
  `;

  return {
    publicationId,
    weekStart: input.weekStart,
    weekEnd,
    publishedShifts: shifts.length,
    activeEmployees: contacts.length,
    openShifts: openShifts.length,
    email,
    sms,
    hubUrl,
  };
}

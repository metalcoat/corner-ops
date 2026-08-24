import { Resend } from "resend";
import { schedulePublicationIdempotencyKey, scheduleStateHash } from "@/lib/schedule-publication-key";
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

type PublicationRow = {
  id: string;
  details: unknown;
  published_at: string;
  delivery_status: string;
  email_sent_count: number;
  email_missing_count: number;
  email_failed_count: number;
  email_configured: boolean;
  sms_sent_count: number;
  sms_missing_count: number;
  sms_failed_count: number;
  sms_configured: boolean;
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

function compactTimeLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
    .replace(":00", "")
    .replace(" AM", "a")
    .replace(" PM", "p");
}

function compactShiftLabel(shift: ScheduleShiftRow): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(new Date(shift.starts_at));
  return `${day} ${compactTimeLabel(shift.starts_at)}-${compactTimeLabel(shift.ends_at)}`;
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
    : "Sign in with your normal Corner Deli employee PIN.";
}

function emailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() || process.env.ALERT_FROM_EMAIL?.trim();
  return apiKey && from ? { resend: new Resend(apiKey), from } : null;
}

function publicationDetails(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
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

function storedEmployeeSchedules(value: unknown): Record<string, string> {
  const details = publicationDetails(value);
  const schedules = details.employeeSchedules;
  if (!schedules || typeof schedules !== "object" || Array.isArray(schedules)) return {};
  return Object.fromEntries(
    Object.entries(schedules as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function employeeScheduleSignatures(shifts: ScheduleShiftRow[]): Record<string, string> {
  const byEmployee = new Map<string, ScheduleShiftRow[]>();
  for (const shift of shifts) {
    if (!shift.employee_id) continue;
    const list = byEmployee.get(shift.employee_id) || [];
    list.push(shift);
    byEmployee.set(shift.employee_id, list);
  }

  return Object.fromEntries(Array.from(byEmployee.entries()).map(([employeeId, employeeShifts]) => {
    const signature = employeeShifts
      .sort((left, right) => {
        const startDifference = new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime();
        return startDifference || String(left.id).localeCompare(String(right.id));
      })
      .map((shift) => JSON.stringify({
        id: shift.id,
        position: clean(shift.position, 100),
        startsAt: String(shift.starts_at),
        endsAt: String(shift.ends_at),
        mealBreakStart: shift.meal_break_start ? String(shift.meal_break_start) : null,
        mealBreakMinutes: Number(shift.meal_break_minutes || 0),
        extraMealBreakStart: shift.extra_meal_break_start ? String(shift.extra_meal_break_start) : null,
        extraMealBreakMinutes: Number(shift.extra_meal_break_minutes || 0),
        notes: clean(shift.notes, 1000),
      }))
      .join("|");
    return [employeeId, signature];
  }));
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
  if (!shifts.length) throw new Error("There are no shifts to publish for this week.");

  const draftRows = shifts.filter((shift) => shift.status === "Draft");
  const priorPublications = await sql`
    SELECT id, details, published_at, delivery_status,
      email_sent_count, email_missing_count, email_failed_count, email_configured,
      sms_sent_count, sms_missing_count, sms_failed_count, sms_configured
    FROM schedule_publications
    WHERE business = ${input.business} AND week_start = ${input.weekStart}
    ORDER BY published_at DESC
    LIMIT 1
  ` as unknown as PublicationRow[];
  const priorPublication = priorPublications[0] || null;
  const isResend = Boolean(priorPublication) && draftRows.length === 0;
  const mode: "initial" | "changes" | "resend" = !priorPublication ? "initial" : isResend ? "resend" : "changes";
  const scheduleVerb = mode === "initial" ? "published" : mode === "resend" ? "resent" : "updated";

  const currentSchedules = employeeScheduleSignatures(shifts);
  const previousSchedules = storedEmployeeSchedules(priorPublication?.details);
  const assignedEmployeeIds = new Set(shifts.flatMap((shift) => shift.employee_id ? [shift.employee_id] : []));
  const draftEmployeeIds = new Set(draftRows.flatMap((shift) => shift.employee_id ? [shift.employee_id] : []));
  const affectedEmployeeIds = new Set<string>();
  if (!priorPublication || isResend) {
    for (const employeeId of assignedEmployeeIds) affectedEmployeeIds.add(employeeId);
  } else if (Object.keys(previousSchedules).length) {
    const employeeIds = new Set([...Object.keys(previousSchedules), ...Object.keys(currentSchedules)]);
    for (const employeeId of employeeIds) {
      if ((previousSchedules[employeeId] || "") !== (currentSchedules[employeeId] || "")) affectedEmployeeIds.add(employeeId);
    }
  } else {
    for (const employeeId of draftEmployeeIds) affectedEmployeeIds.add(employeeId);
  }

  const allContacts = await activeContacts(input.business);
  const contacts = allContacts.filter((employee) => affectedEmployeeIds.has(employee.id));
  const openShifts = shifts.filter((shift) => !shift.employee_id);
  const rangeLabel = `${dateLabel(input.weekStart)} through ${dateLabel(weekEnd)}`;
  const hubUrl = employeeHubUrl(input.business);
  const accessInstruction = pinInstruction(input.business);
  const stateHash = scheduleStateHash(shifts);
  const priorDetails = publicationDetails(priorPublication?.details);
  const priorStateHash = String(priorDetails.scheduleHash || "");
  const priorAgeMs = priorPublication ? Date.now() - new Date(priorPublication.published_at).getTime() : Number.POSITIVE_INFINITY;

  if (isResend && priorPublication && priorStateHash === stateHash && priorAgeMs >= 0 && priorAgeMs < 120_000) {
    return {
      publicationId: priorPublication.id,
      duplicate: true,
      weekStart: input.weekStart,
      weekEnd,
      publishedShifts: shifts.length,
      activeEmployees: allContacts.length,
      affectedEmployees: contacts.length,
      openShifts: openShifts.length,
      mode,
      deliveryStatus: priorPublication.delivery_status,
      email: {
        configured: priorPublication.email_configured,
        sent: Number(priorPublication.email_sent_count || 0),
        failed: Number(priorPublication.email_failed_count || 0),
        missingEmail: Number(priorPublication.email_missing_count || 0),
      },
      sms: {
        configured: priorPublication.sms_configured,
        sent: Number(priorPublication.sms_sent_count || 0),
        failed: Number(priorPublication.sms_failed_count || 0),
        missingPhone: Number(priorPublication.sms_missing_count || 0),
        notOptedIn: 0,
      },
    };
  }

  const idempotencyKey = schedulePublicationIdempotencyKey({
    business: input.business,
    weekStart: input.weekStart,
    previousPublicationId: priorPublication?.id || null,
    stateHash,
    mode,
  });
  const publicationId = crypto.randomUUID();
  const baseDetails = {
    scheduleHash: stateHash,
    employeeSchedules: currentSchedules,
    affectedEmployeeIds: Array.from(affectedEmployeeIds),
    notificationRecipientIds: contacts.map((employee) => employee.id),
    openShiftCount: openShifts.length,
    mode,
    hubUrl,
    pinInstruction: accessInstruction,
  };

  const reserved = await sql`
    INSERT INTO schedule_publications (
      id, business, week_start, week_end, published_by, shift_count,
      active_employee_count, email_sent_count, email_missing_count,
      email_failed_count, email_configured, sms_sent_count, sms_missing_count,
      sms_failed_count, sms_configured, details, idempotency_key, delivery_status
    ) VALUES (
      ${publicationId}, ${input.business}, ${input.weekStart}, ${weekEnd}, ${input.actor}, ${shifts.length},
      ${contacts.length}, 0, 0, 0, FALSE, 0, 0, 0, FALSE,
      ${JSON.stringify(baseDetails)}::jsonb, ${idempotencyKey}, 'Pending'
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  ` as unknown as Array<{ id: string }>;

  if (!reserved[0]) {
    const existing = await sql`
      SELECT id, delivery_status, email_sent_count, email_missing_count, email_failed_count, email_configured,
        sms_sent_count, sms_missing_count, sms_failed_count, sms_configured
      FROM schedule_publications WHERE idempotency_key = ${idempotencyKey} LIMIT 1
    ` as unknown as PublicationRow[];
    const row = existing[0];
    return {
      publicationId: row?.id || null,
      duplicate: true,
      weekStart: input.weekStart,
      weekEnd,
      publishedShifts: shifts.length,
      activeEmployees: allContacts.length,
      affectedEmployees: contacts.length,
      openShifts: openShifts.length,
      mode,
      deliveryStatus: row?.delivery_status || "Pending",
      email: { configured: Boolean(row?.email_configured), sent: Number(row?.email_sent_count || 0), failed: Number(row?.email_failed_count || 0), missingEmail: Number(row?.email_missing_count || 0) },
      sms: { configured: Boolean(row?.sms_configured), sent: Number(row?.sms_sent_count || 0), failed: Number(row?.sms_failed_count || 0), missingPhone: Number(row?.sms_missing_count || 0), notOptedIn: 0 },
    };
  }

  const messageQueries = contacts.map((employee) => sql`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, ${employee.id}, 'Direct',
      ${`Your ${input.business} schedule was ${scheduleVerb} for ${rangeLabel}.${hubUrl ? ` Review it in the Employee Portal: ${hubUrl}` : " Review it in the Employee Hub."}`}
    )
  `);

  try {
    await sql.transaction([
      sql`
        UPDATE schedule_shifts SET
          status = CASE WHEN employee_id IS NULL THEN 'Open' ELSE 'Published' END,
          published_at = NOW(), updated_at = NOW()
        WHERE business = ${input.business}
          AND starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
          AND starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
          AND status <> 'Cancelled'
      `,
      ...messageQueries,
      sql`UPDATE schedule_publications SET delivery_status = 'Sending' WHERE id = ${publicationId}`,
    ]);
  } catch (error) {
    await sql`
      UPDATE schedule_publications SET delivery_status = 'Failed',
        details = details || ${JSON.stringify({ transactionError: error instanceof Error ? error.message : String(error) })}::jsonb,
        delivery_completed_at = NOW()
      WHERE id = ${publicationId}
    `;
    throw error;
  }

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
        `Your ${input.business} schedule for ${rangeLabel} was ${scheduleVerb}.`,
        "",
        "Your current schedule:",
        schedule,
        hubUrl ? `\nOpen the ${input.business} Employee Portal: ${hubUrl}` : "",
        accessInstruction,
        "",
        "This email was sent by Corner Ops.",
      ].filter(Boolean).join("\n");
    },
  });
  const sms = await deliverSms({
    recipients: contacts,
    text: (employee) => {
      const employeeShifts = shifts.filter((shift) => shift.employee_id === employee.id);
      const schedule = employeeShifts.length ? employeeShifts.map(compactShiftLabel).join("; ") : "No shifts currently assigned.";
      return [
        `${clean(employee.name, 120).split(/\s+/)[0] || "Your"}, your ${input.business} schedule was ${scheduleVerb} for ${dateLabel(input.weekStart)}-${dateLabel(weekEnd)}.`,
        `Shifts: ${schedule}`,
        hubUrl ? `Portal: ${hubUrl}` : "Open Employee Hub to review.",
        accessInstruction,
        "Reply STOP to opt out.",
      ].join(" ");
    },
  });

  const deliveryStatus = email.failed || sms.failed || !email.configured || !sms.configured ? "CompletedWithWarnings" : "Completed";
  const finalDetails = {
    ...baseDetails,
    emailFailures: email.failures,
    emailSkipped: email.skipped,
    smsFailures: sms.failures,
    smsNotOptedIn: sms.notOptedIn,
    smsSkipped: sms.skipped,
  };
  await sql`
    UPDATE schedule_publications SET
      email_sent_count = ${email.sent}, email_missing_count = ${email.missingEmail},
      email_failed_count = ${email.failed}, email_configured = ${email.configured},
      sms_sent_count = ${sms.sent}, sms_missing_count = ${sms.missingPhone},
      sms_failed_count = ${sms.failed}, sms_configured = ${sms.configured},
      details = ${JSON.stringify(finalDetails)}::jsonb,
      delivery_status = ${deliveryStatus}, delivery_completed_at = NOW()
    WHERE id = ${publicationId}
  `;

  return {
    publicationId,
    weekStart: input.weekStart,
    weekEnd,
    publishedShifts: shifts.length,
    activeEmployees: allContacts.length,
    affectedEmployees: contacts.length,
    affectedEmployeeIds: contacts.map((employee) => employee.id),
    openShifts: openShifts.length,
    email,
    sms,
    hubUrl,
    mode,
    deliveryStatus,
  };
}

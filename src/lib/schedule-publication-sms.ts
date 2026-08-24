import { getSql } from "@/lib/db";
import { deliverSms, type SmsRecipient } from "@/lib/sms-notifications";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

type ScheduleSmsContact = SmsRecipient;

type ScheduleSmsShift = {
  employee_id: string | null;
  position: string;
  starts_at: string;
  ends_at: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
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

function compactTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
    .replace(":00", "")
    .replace(" AM", "a")
    .replace(" PM", "p");
}

function compactShift(shift: ScheduleSmsShift): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(new Date(shift.starts_at));
  return `${day} ${compactTime(shift.starts_at)}-${compactTime(shift.ends_at)} ${clean(shift.position, 40) || "Shift"}`;
}

export function scheduleSmsText(input: {
  business: Business;
  mode: "initial" | "changes" | "resend";
  shifts: ScheduleSmsShift[];
  hubUrl?: string;
}) {
  const verb = input.mode === "initial" ? "published" : input.mode === "resend" ? "resent" : "updated";
  const schedule = input.shifts.length
    ? input.shifts.map(compactShift).join("; ")
    : "No shifts assigned this week.";
  return [
    `${input.business} schedule ${verb}: ${schedule}`,
    input.hubUrl ? `View/current changes: ${input.hubUrl}` : "",
    "Reply STOP to opt out.",
  ].filter(Boolean).join(" ");
}

export async function deliverSchedulePublicationSms(input: {
  business: Business;
  weekStart: string;
  publicationId: string;
  employeeIds: string[];
  mode: "initial" | "changes" | "resend";
}) {
  const employeeIds = new Set(input.employeeIds.map(String).filter(Boolean));
  const sql = getSql();
  const contactsRows = await sql`
    SELECT id, name, phone, sms_opt_in
    FROM employees
    WHERE business = ${input.business} AND active = TRUE
    ORDER BY name
  ` as unknown as Array<{ id: string; name: string; phone: string; sms_opt_in: boolean }>;
  const contacts: ScheduleSmsContact[] = contactsRows
    .filter((row) => employeeIds.has(String(row.id)))
    .map((row) => ({
      id: String(row.id),
      name: clean(row.name, 120),
      phone: row.phone || "",
      smsOptIn: Boolean(row.sms_opt_in),
    }));

  const shifts = await sql`
    SELECT employee_id, position, starts_at, ends_at
    FROM schedule_shifts
    WHERE business = ${input.business}
      AND starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND status <> 'Cancelled'
    ORDER BY starts_at
  ` as unknown as ScheduleSmsShift[];

  const hubUrl = employeeHubUrl(input.business);
  const sms = await deliverSms({
    recipients: contacts,
    text: (employee) => scheduleSmsText({
      business: input.business,
      mode: input.mode,
      shifts: shifts.filter((shift) => shift.employee_id === employee.id),
      hubUrl,
    }),
  });

  try {
    await sql`
      UPDATE schedule_publications SET
        sms_sent_count = ${sms.sent},
        sms_missing_count = ${sms.missingPhone},
        sms_failed_count = ${sms.failed},
        sms_configured = ${sms.configured},
        details = details || ${JSON.stringify({
          smsFailures: sms.failures,
          smsAccepted: sms.accepted,
          smsNotOptedIn: sms.notOptedIn,
          smsSkipped: sms.skipped,
        })}::jsonb
      WHERE id = ${input.publicationId}
    `;
  } catch (error) {
    console.error("[schedule-sms] could not persist SMS delivery results", error);
  }

  return sms;
}

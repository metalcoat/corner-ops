import { getSql } from "@/lib/db";
import { deliverSms, type SmsRecipient } from "@/lib/sms-notifications";
import { scheduleSmsText, type ScheduleSmsShift } from "@/lib/schedule-sms-text";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

type ScheduleSmsContact = SmsRecipient;

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

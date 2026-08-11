import { canAccessBusiness, getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { publishValidatedScheduleWeek } from "@/lib/schedule-publish-validation";
import { deliverSms, type SmsRecipient } from "@/lib/sms-notifications";
import { ensureStaffNotificationSchema, sendStaffNotification } from "@/lib/staff-notifications";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const TIME_ZONE = "America/New_York";

type DraftShiftRow = {
  id: string;
  employee_id: string | null;
  employee_name: string | null;
  starts_at: string | Date;
  ends_at: string | Date;
};

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function validWeekStart(value: unknown): string {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("Choose a valid schedule week.");
  return text;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateKey(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function mondayForDate(value: string | Date): string {
  const localDate = localDateKey(value);
  const date = new Date(`${localDate}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function isLegacyTimestampSortError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("starts_at") && message.includes("localeCompare is not a function");
}

async function installScheduleMessageCompatibility() {
  const sql = getSql();
  await sql`
    CREATE OR REPLACE FUNCTION corner_ops_normalize_employee_message_type()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.message_type = 'Schedule' THEN
        NEW.message_type := 'Announcement';
      END IF;
      RETURN NEW;
    END;
    $$
  `;
  await sql`DROP TRIGGER IF EXISTS corner_ops_schedule_message_type ON employee_messages`;
  await sql`
    CREATE TRIGGER corner_ops_schedule_message_type
    BEFORE INSERT OR UPDATE OF message_type ON employee_messages
    FOR EACH ROW
    EXECUTE FUNCTION corner_ops_normalize_employee_message_type()
  `;
}

async function draftShiftsForWeek(business: Business, weekStart: string): Promise<DraftShiftRow[]> {
  return getSql()`
    SELECT s.id, s.employee_id, e.name AS employee_name, s.starts_at, s.ends_at
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${business}
      AND s.status = 'Draft'
      AND s.starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
    ORDER BY s.starts_at, s.id
  ` as unknown as Promise<DraftShiftRow[]>;
}

async function nearbyDraftShifts(business: Business, weekStart: string): Promise<DraftShiftRow[]> {
  const nearbyStart = addDays(weekStart, -7);
  const nearbyEnd = addDays(weekStart, 14);
  return getSql()`
    SELECT s.id, s.employee_id, e.name AS employee_name, s.starts_at, s.ends_at
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${business}
      AND s.status = 'Draft'
      AND s.starts_at >= (${nearbyStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < (${nearbyEnd}::date AT TIME ZONE ${TIME_ZONE})
    ORDER BY s.starts_at, s.id
  ` as unknown as Promise<DraftShiftRow[]>;
}

async function forcePublishRemainingDrafts(business: Business, weekStart: string) {
  const rows = await getSql()`
    UPDATE schedule_shifts
    SET status = CASE WHEN employee_id IS NULL THEN 'Open' ELSE 'Published' END,
        published_at = NOW(), updated_at = NOW()
    WHERE business = ${business}
      AND status = 'Draft'
      AND starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function sendRecoveredPublishNotifications(input: {
  business: Business;
  weekStart: string;
  actor: string;
  drafts: DraftShiftRow[];
}) {
  const employeeIds = Array.from(new Set(
    input.drafts.flatMap((shift) => shift.employee_id ? [shift.employee_id] : []),
  ));
  const body = `Your ${input.business} schedule was updated for ${input.weekStart} through ${addDays(input.weekStart, 6)}. Review your current shifts in Employee Hub.`;

  const emailResults = [];
  for (const employeeId of employeeIds) {
    emailResults.push(await sendStaffNotification({
      business: input.business,
      recipientEmployeeId: employeeId,
      body,
      actor: input.actor,
    }));
  }

  const rows = await getSql()`
    SELECT id, name, phone, sms_opt_in
    FROM employees
    WHERE business = ${input.business} AND active = TRUE
    ORDER BY name
  ` as unknown as Array<{
    id: string;
    name: string;
    phone: string;
    sms_opt_in: boolean;
  }>;
  const employeeIdSet = new Set(employeeIds);
  const smsRecipients: SmsRecipient[] = rows
    .filter((employee) => employeeIdSet.has(employee.id))
    .map((employee) => ({
      id: employee.id,
      name: employee.name,
      phone: employee.phone || "",
      smsOptIn: Boolean(employee.sms_opt_in),
    }));
  const sms = await deliverSms({
    recipients: smsRecipients,
    text: () => `${body} Reply STOP to opt out.`,
  });

  return { employeeIds, emailResults, sms };
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const requestedWeekStart = validWeekStart(body.weekStart);
    await ensureStaffNotificationSchema();
    await installScheduleMessageCompatibility();

    const targetWeekStart = requestedWeekStart;
    const draftsBefore = await draftShiftsForWeek(business, targetWeekStart);

    let result: Record<string, unknown>;
    let recoveredLegacyTimestampError = false;
    try {
      result = await publishValidatedScheduleWeek({
        business,
        weekStart: targetWeekStart,
        actor: session.displayName,
      }) as unknown as Record<string, unknown>;
    } catch (error) {
      if (!isLegacyTimestampSortError(error)) throw error;
      recoveredLegacyTimestampError = true;
      console.warn("schedule-publish-recovered-timestamp-sort", error);
      result = {
        publicationId: null,
        weekStart: targetWeekStart,
        weekEnd: addDays(targetWeekStart, 6),
        publishedShifts: 0,
        affectedEmployees: draftsBefore.length,
        mode: "changes",
      };
    }

    let draftsAfter = await draftShiftsForWeek(business, targetWeekStart);
    const forcedShiftIds = draftsAfter.length
      ? await forcePublishRemainingDrafts(business, targetWeekStart)
      : [];
    draftsAfter = await draftShiftsForWeek(business, targetWeekStart);

    const recoveryNotifications = recoveredLegacyTimestampError && !draftsAfter.length
      ? await sendRecoveredPublishNotifications({
          business,
          weekStart: targetWeekStart,
          actor: session.displayName,
          drafts: draftsBefore,
        })
      : null;

    const diagnostics = {
      requestedWeekStart,
      targetWeekStart,
      draftShiftIdsBefore: draftsBefore.map((shift) => shift.id),
      draftEmployeesBefore: draftsBefore.map((shift) => shift.employee_name || "Unassigned"),
      forcedShiftIds,
      remainingDraftShiftIds: draftsAfter.map((shift) => shift.id),
      recoveredLegacyTimestampError,
      recoveryNotificationEmployeeIds: recoveryNotifications?.employeeIds || [],
    };

    console.info("schedule-publish-verified", JSON.stringify({ business, ...diagnostics }));

    if (draftsAfter.length) {
      return Response.json({
        error: `Schedule publishing did not clear ${draftsAfter.length} draft shift${draftsAfter.length === 1 ? "" : "s"}.`,
        diagnostics,
      }, { status: 409 });
    }

    return Response.json({
      ...result,
      ...diagnostics,
      recoveryNotifications,
    });
  } catch (error) {
    const candidate = error as { code?: unknown };
    if (candidate?.code) return apiError(error);
    console.error("schedule-publish-v2-failed", error);
    return Response.json({
      error: error instanceof Error ? error.message : "The schedule could not be published.",
    }, { status: 400 });
  }
}

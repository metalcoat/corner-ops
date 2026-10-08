import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import { ValidationError } from "@/lib/http";
import {
  addDays,
  businessDayCloseUtc,
  closeBasisLabel,
  clockOutTimeProblem,
  employeeLeftAtOwnerEmail,
  formatDateTime,
  localDateKey,
  MAX_OWNER_SHIFT_HOURS,
  missedClockOutDecision,
  missedClockOutOwnerEmail,
  missedClockOutSmsPlan,
  missedClockOutSmsText,
  parseEasternInput,
  resolveMissedClockOutClose,
  weekdayOf,
  type CloseBasis,
  type HoursWindow,
} from "@/lib/missed-clock-out-rules";
import { ensurePayrollControlSchema } from "@/lib/payroll-control";
import { correctPunch } from "@/lib/payroll-punch-correction";
import { payrollWeekBounds } from "@/lib/payroll-week";
import { publicTeamBaseUrl } from "@/lib/public-team-url";
import { deliverSms } from "@/lib/sms-notifications";
import { toIsoTimestamp, toTimestampDate } from "@/lib/timestamp-values";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import type { Business } from "@/lib/types";

/**
 * Missed clock-outs: a time_entries punch still open an hour after its
 * business day closed. Each open punch gets exactly one case (unique on
 * time_entry_id); the employee is texted once (with consent) and the owner
 * gets one summary email per business per run. Closing the punch always goes
 * through correctPunch, the same audited path payroll control uses.
 */

const BUSINESSES: Business[] = ["Corner Deli", "Tiki"];

let schemaPromise: Promise<void> | null = null;

export function ensureMissedClockOutSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensurePayrollControlSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS missed_clock_out_cases (
          id UUID PRIMARY KEY,
          time_entry_id UUID NOT NULL UNIQUE REFERENCES time_entries(id) ON DELETE CASCADE,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL,
          employee_name TEXT NOT NULL,
          position TEXT NOT NULL DEFAULT '',
          clock_in TIMESTAMPTZ NOT NULL,
          business_date DATE NOT NULL,
          close_basis TEXT NOT NULL CHECK (close_basis IN ('business_close', 'scheduled_end', 'max_shift')),
          close_at TIMESTAMPTZ NOT NULL,
          shift_id UUID,
          scheduled_end TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Submitted', 'Resolved')),
          employee_left_at TIMESTAMPTZ,
          employee_note TEXT NOT NULL DEFAULT '',
          employee_submitted_at TIMESTAMPTZ,
          sms_status TEXT NOT NULL DEFAULT '',
          sms_detail TEXT NOT NULL DEFAULT '',
          sms_sent_at TIMESTAMPTZ,
          owner_notified_at TIMESTAMPTZ,
          owner_notify_error TEXT NOT NULL DEFAULT '',
          resolution TEXT NOT NULL DEFAULT '' CHECK (resolution IN ('', 'scheduled_end', 'employee_time', 'custom', 'closed_elsewhere')),
          resolved_clock_out TIMESTAMPTZ,
          resolved_by TEXT NOT NULL DEFAULT '',
          resolved_at TIMESTAMPTZ,
          detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS missed_clock_out_cases_business_idx ON missed_clock_out_cases (business, status, clock_in DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS missed_clock_out_cases_employee_idx ON missed_clock_out_cases (employee_id, clock_in DESC)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

/** Owner address(es) for payroll and clock-out notices: PAYROLL_NOTIFY_EMAIL, else APP_EMAIL. */
export function payrollNotifyEmails(): string[] {
  const configured = (process.env.PAYROLL_NOTIFY_EMAIL || "").split(/[;,]/).map((value) => value.trim().toLowerCase()).filter((value) => /^\S+@\S+\.\S+$/.test(value));
  if (configured.length) return [...new Set(configured)];
  const fallback = (process.env.APP_EMAIL || "").trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(fallback) ? [fallback] : [];
}

export function ownerClockOutLink(business: Business, caseId: string): string {
  return `${publicTeamBaseUrl(business)}/ops/payroll-control/clock-outs?case=${encodeURIComponent(caseId)}`;
}

export function employeeClockOutLink(business: Business, caseId: string): string {
  return `${publicTeamBaseUrl(business)}/employee/attendance?business=${encodeURIComponent(business)}&clockout=${encodeURIComponent(caseId)}`;
}

type CaseRow = {
  id: string;
  time_entry_id: string;
  business: Business;
  employee_id: string;
  employee_name: string;
  position: string;
  clock_in: string;
  business_date: string | Date;
  close_basis: CloseBasis;
  close_at: string;
  shift_id: string | null;
  scheduled_end: string | null;
  status: "Open" | "Submitted" | "Resolved";
  employee_left_at: string | null;
  employee_note: string;
  employee_submitted_at: string | null;
  sms_status: string;
  sms_detail: string;
  sms_sent_at: string | null;
  owner_notified_at: string | null;
  owner_notify_error: string;
  resolution: string;
  resolved_clock_out: string | null;
  resolved_by: string;
  resolved_at: string | null;
  detected_at: string;
};

function dateText(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function eastern(value: unknown): string | null {
  const date = toTimestampDate(value);
  return date ? formatDateTime(date) : null;
}

const SMS_LABELS: Record<string, string> = {
  sent: "Texted",
  sending: "Text not confirmed",
  failed: "Text failed",
  not_opted_in: "Not texted (no SMS consent)",
  no_phone: "Not texted (no phone number)",
  too_late: "Not texted (found more than a day late)",
  inactive: "Not texted (inactive employee)",
  not_configured: "Not texted (SMS not configured)",
};

/** New API fields: ISO timestamps (raw PostgreSQL text never reaches these pages). */
export function mapMissedClockOutCase(row: CaseRow) {
  return {
    id: String(row.id),
    timeEntryId: String(row.time_entry_id),
    business: row.business,
    employeeId: String(row.employee_id),
    employeeName: row.employee_name,
    position: row.position,
    clockIn: toIsoTimestamp(row.clock_in),
    clockInEastern: eastern(row.clock_in),
    businessDate: dateText(row.business_date),
    closeBasis: row.close_basis,
    closeBasisLabel: closeBasisLabel(row.close_basis),
    closeAt: toIsoTimestamp(row.close_at),
    shiftId: row.shift_id ? String(row.shift_id) : null,
    scheduledEnd: toIsoTimestamp(row.scheduled_end),
    scheduledEndEastern: eastern(row.scheduled_end),
    status: row.status,
    employeeLeftAt: toIsoTimestamp(row.employee_left_at),
    employeeLeftAtEastern: eastern(row.employee_left_at),
    employeeNote: row.employee_note,
    employeeSubmittedAt: toIsoTimestamp(row.employee_submitted_at),
    smsStatus: row.sms_status,
    smsLabel: SMS_LABELS[row.sms_status] || (row.sms_status ? row.sms_status : "Not texted"),
    ownerNotifiedAt: toIsoTimestamp(row.owner_notified_at),
    resolution: row.resolution,
    resolvedClockOut: toIsoTimestamp(row.resolved_clock_out),
    resolvedClockOutEastern: eastern(row.resolved_clock_out),
    resolvedBy: row.resolved_by,
    resolvedAt: toIsoTimestamp(row.resolved_at),
    detectedAt: toIsoTimestamp(row.detected_at),
  };
}

export type MissedClockOutCaseView = ReturnType<typeof mapMissedClockOutCase>;

/** Cases whose punch was closed some other way (payroll correction, a later clock-out) are resolved. */
export async function reconcileMissedClockOutCases(): Promise<number> {
  await ensureMissedClockOutSchema();
  const rows = await getSql()`
    UPDATE missed_clock_out_cases c SET
      status = 'Resolved', resolution = 'closed_elsewhere', resolved_clock_out = t.clock_out,
      resolved_by = 'Corner Ops', resolved_at = NOW(), updated_at = NOW()
    FROM time_entries t
    WHERE t.id = c.time_entry_id AND c.status <> 'Resolved' AND t.clock_out IS NOT NULL
    RETURNING c.id
  ` as unknown as Array<{ id: string }>;
  return rows.length;
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await getSql()`SELECT to_regclass(${name}::text) IS NOT NULL AS present` as unknown as Array<{ present: boolean }>;
  return Boolean(rows[0]?.present);
}

type HoursSource = {
  weekly: Array<{ weekday: number; service_type: string; opens_at: string; closes_at: string }>;
  special: Map<string, { status: string; opens_at: string | null; closes_at: string | null }>;
};

/**
 * Each business's opening hours: the ordering "operating windows" (Settings >
 * store hours; service 'all' preferred) with that date's special hours or
 * closure taking precedence. A business with none configured returns no close.
 */
async function loadHours(business: Business, fromDate: string, toDate: string): Promise<HoursSource> {
  const source: HoursSource = { weekly: [], special: new Map() };
  if (await tableExists("public.ordering_operating_windows")) {
    source.weekly = await getSql()`
      SELECT weekday, service_type, opens_at::text AS opens_at, closes_at::text AS closes_at
      FROM ordering_operating_windows
      WHERE business = ${business} AND active = TRUE
    ` as unknown as HoursSource["weekly"];
  }
  if (await tableExists("public.ordering_special_hours")) {
    const rows = await getSql()`
      SELECT business_date::text AS business_date, status, opens_at::text AS opens_at, closes_at::text AS closes_at
      FROM ordering_special_hours
      WHERE business = ${business} AND service_type = 'all'
        AND business_date BETWEEN ${fromDate}::date AND ${toDate}::date
    ` as unknown as Array<{ business_date: string; status: string; opens_at: string | null; closes_at: string | null }>;
    for (const row of rows) source.special.set(String(row.business_date).slice(0, 10), row);
  }
  return source;
}

function windowsForDate(source: HoursSource, dateKey: string): HoursWindow[] {
  const special = source.special.get(dateKey);
  if (special?.status === "closed") return [];
  if (special?.status === "custom_hours" && special.opens_at && special.closes_at) return [{ opens: special.opens_at, closes: special.closes_at }];
  const weekday = weekdayOf(dateKey);
  const general = source.weekly.some((row) => row.service_type === "all");
  return source.weekly
    .filter((row) => Number(row.weekday) === weekday && (!general || row.service_type === "all"))
    .map((row) => ({ opens: row.opens_at, closes: row.closes_at }));
}

type OpenEntryRow = {
  id: string;
  business: Business;
  employee_id: string;
  employee_name: string;
  position: string;
  clock_in: string;
  phone: string | null;
  sms_opt_in: boolean | null;
  active: boolean | null;
};

async function matchingShift(entry: OpenEntryRow) {
  const rows = await getSql()`
    SELECT id, starts_at, ends_at
    FROM schedule_shifts
    WHERE business = ${entry.business} AND employee_id = ${entry.employee_id} AND status = 'Published'
      AND starts_at <= ${entry.clock_in}::timestamptz + INTERVAL '3 hours'
      AND ends_at > ${entry.clock_in}::timestamptz
    ORDER BY ABS(EXTRACT(EPOCH FROM (starts_at - ${entry.clock_in}::timestamptz)))
    LIMIT 1
  ` as unknown as Array<{ id: string; starts_at: string; ends_at: string }>;
  return rows[0] || null;
}

async function sendOwnerSummaries(now: Date) {
  const results: Record<string, unknown> = {};
  const recipients = payrollNotifyEmails();
  for (const business of BUSINESSES) {
    // Claim the cases first so an overlapping run cannot email them again.
    const claimed = await getSql()`
      UPDATE missed_clock_out_cases SET owner_notified_at = NOW(), updated_at = NOW()
      WHERE business = ${business} AND owner_notified_at IS NULL AND detected_at >= NOW() - INTERVAL '7 days'
      RETURNING *
    ` as unknown as CaseRow[];
    if (!claimed.length) continue;
    const email = missedClockOutOwnerEmail({
      business,
      cases: claimed
        .sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)))
        .map((row) => ({
          employeeName: row.employee_name,
          clockIn: toTimestampDate(row.clock_in) || now,
          scheduledEnd: toTimestampDate(row.scheduled_end),
          smsNote: SMS_LABELS[row.sms_status] || "Not texted",
          link: ownerClockOutLink(business, String(row.id)),
        })),
    });
    let sent = 0;
    let error = "";
    try {
      if (!recipients.length) throw new Error("PAYROLL_NOTIFY_EMAIL / APP_EMAIL is not set.");
      const delivery = await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text });
      sent = delivery.sent;
      error = delivery.failures.join("; ");
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const ids = claimed.map((row) => String(row.id));
    if (!sent) {
      // Nothing went out: release the claim so the next run tries again.
      await getSql()`UPDATE missed_clock_out_cases SET owner_notified_at = NULL, owner_notify_error = ${error.slice(0, 500)} WHERE id = ANY(${ids}::uuid[])`;
    } else if (error) {
      await getSql()`UPDATE missed_clock_out_cases SET owner_notify_error = ${error.slice(0, 500)} WHERE id = ANY(${ids}::uuid[])`;
    }
    results[business] = { cases: ids.length, sent, error };
  }
  return results;
}

/**
 * The 15-minute job. For every open punch past its close + 60 minutes and
 * without a case: create the case, text the employee (consent only), then one
 * owner email per business. dryRun reports what would happen without writing
 * or sending anything.
 */
export async function runMissedClockOuts(options: { now?: Date; dryRun?: boolean } = {}) {
  await ensureMissedClockOutSchema();
  const now = options.now ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const reconciled = dryRun ? 0 : await reconcileMissedClockOutCases();
  const entries = await getSql()`
    SELECT t.id, t.business, t.employee_id, t.employee_name, t.position, t.clock_in,
      e.phone, e.sms_opt_in, e.active
    FROM time_entries t
    LEFT JOIN missed_clock_out_cases c ON c.time_entry_id = t.id
    LEFT JOIN employees e ON e.id = t.employee_id
    WHERE t.clock_out IS NULL AND c.id IS NULL
      AND t.clock_in <= ${now.toISOString()}::timestamptz - INTERVAL '60 minutes'
    ORDER BY t.clock_in
    LIMIT 200
  ` as unknown as OpenEntryRow[];

  const hoursCache = new Map<Business, HoursSource>();
  const created: Array<Record<string, unknown>> = [];
  const pending: Array<Record<string, unknown>> = [];
  const errors: string[] = [];

  for (const entry of entries) {
    try {
      const clockIn = toTimestampDate(entry.clock_in);
      if (!clockIn) continue;
      if (!hoursCache.has(entry.business)) {
        const today = localDateKey(now);
        hoursCache.set(entry.business, await loadHours(entry.business, addDays(today, -45), addDays(today, 1)));
      }
      const hours = hoursCache.get(entry.business)!;
      const clockInDate = localDateKey(clockIn);
      const closes = [addDays(clockInDate, -1), clockInDate].map((businessDate) => ({
        businessDate,
        closeAt: businessDayCloseUtc(businessDate, windowsForDate(hours, businessDate)),
      }));
      const shift = await matchingShift(entry);
      const scheduledEnd = shift ? toTimestampDate(shift.ends_at) : null;
      const close = resolveMissedClockOutClose({ clockIn, closes, scheduledEnd });
      const decision = missedClockOutDecision({ now, dueAt: close.dueAt, hasCase: false, clockedOut: false });
      const summary = {
        timeEntryId: String(entry.id), business: entry.business, employeeName: entry.employee_name,
        clockIn: clockIn.toISOString(), closeBasis: close.basis, closeAt: close.closeAt.toISOString(),
        dueAt: close.dueAt.toISOString(), scheduledEnd: scheduledEnd?.toISOString() || null,
      };
      if (decision !== "create") {
        pending.push(summary);
        continue;
      }
      const smsPlan = missedClockOutSmsPlan({
        now, dueAt: close.dueAt, smsOptIn: Boolean(entry.sms_opt_in), phone: String(entry.phone || ""), active: entry.active !== false,
      });
      if (dryRun) {
        created.push({ ...summary, wouldText: smsPlan.send, smsSkipReason: smsPlan.send ? "" : smsPlan.reason });
        continue;
      }

      const inserted = await getSql()`
        INSERT INTO missed_clock_out_cases (
          id, time_entry_id, business, employee_id, employee_name, position, clock_in,
          business_date, close_basis, close_at, shift_id, scheduled_end, sms_status
        ) VALUES (
          ${crypto.randomUUID()}, ${entry.id}, ${entry.business}, ${entry.employee_id}, ${entry.employee_name},
          ${String(entry.position || "").slice(0, 100)}, ${clockIn.toISOString()}, ${close.businessDate}::date,
          ${close.basis}, ${close.closeAt.toISOString()}, ${shift?.id || null}, ${scheduledEnd?.toISOString() || null},
          ${smsPlan.send ? "sending" : smsPlan.reason}
        )
        ON CONFLICT (time_entry_id) DO NOTHING
        RETURNING id
      ` as unknown as Array<{ id: string }>;
      const caseId = inserted[0]?.id ? String(inserted[0].id) : "";
      if (!caseId) continue; // Another run created it first; that run texts.
      await getSql()`
        UPDATE time_entries SET status = 'Needs Review', updated_at = NOW()
        WHERE id = ${entry.id} AND clock_out IS NULL AND status IN ('Open', 'Complete')
      `;

      let smsStatus = smsPlan.send ? "sending" : smsPlan.reason;
      let smsDetail = "";
      if (smsPlan.send) {
        try {
          const result = await deliverSms({
            recipients: [{ id: String(entry.employee_id), name: entry.employee_name, phone: String(entry.phone || ""), smsOptIn: Boolean(entry.sms_opt_in) }],
            text: () => missedClockOutSmsText({ employeeName: entry.employee_name, business: entry.business, clockIn, now, link: employeeClockOutLink(entry.business, caseId) }),
          });
          if (!result.configured) smsStatus = "not_configured";
          else if (result.sent) { smsStatus = "sent"; smsDetail = result.accepted[0]?.messageId || ""; }
          else if (result.missingPhone) smsStatus = "no_phone";
          else { smsStatus = "failed"; smsDetail = result.failures[0]?.message || ""; }
        } catch (error) {
          smsStatus = "failed";
          smsDetail = error instanceof Error ? error.message : String(error);
        }
        await getSql()`
          UPDATE missed_clock_out_cases SET sms_status = ${smsStatus}, sms_detail = ${smsDetail.slice(0, 500)},
            sms_sent_at = ${smsStatus === "sent" ? now.toISOString() : null}, updated_at = NOW()
          WHERE id = ${caseId}
        `;
      }
      created.push({ ...summary, caseId, smsStatus });
    } catch (error) {
      errors.push(`${entry.employee_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ownerEmails = dryRun ? {} : await sendOwnerSummaries(now);
  return { dryRun, checkedAt: now.toISOString(), reconciled, openPunches: entries.length, created, pending, ownerEmails, errors };
}

// ---------------------------------------------------------------------------
// Reading cases

export async function missedClockOutCasesForBusiness(business: Business, options: { weekStart?: string; includeResolved?: boolean } = {}) {
  await reconcileMissedClockOutCases();
  const bounds = options.weekStart ? payrollWeekBounds(options.weekStart) : null;
  const rows = bounds
    ? await getSql()`
        SELECT * FROM missed_clock_out_cases
        WHERE business = ${business} AND clock_in >= ${bounds.start.toISOString()} AND clock_in < ${bounds.end.toISOString()}
        ORDER BY CASE status WHEN 'Submitted' THEN 0 WHEN 'Open' THEN 1 ELSE 2 END, clock_in DESC
      ` as unknown as CaseRow[]
    : await getSql()`
        SELECT * FROM missed_clock_out_cases
        WHERE business = ${business}
          AND (status <> 'Resolved' OR (${Boolean(options.includeResolved)}::boolean AND clock_in >= NOW() - INTERVAL '60 days'))
        ORDER BY CASE status WHEN 'Submitted' THEN 0 WHEN 'Open' THEN 1 ELSE 2 END, clock_in DESC
        LIMIT 200
      ` as unknown as CaseRow[];
  return rows.map(mapMissedClockOutCase);
}

export async function getMissedClockOutCase(id: string) {
  await ensureMissedClockOutSchema();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  await reconcileMissedClockOutCases();
  const rows = await getSql()`SELECT * FROM missed_clock_out_cases WHERE id = ${id} LIMIT 1` as unknown as CaseRow[];
  return rows[0] ? mapMissedClockOutCase(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Employee side

export async function employeeMissedClockOutCases(session: EmployeeSession) {
  await reconcileMissedClockOutCases();
  const rows = await getSql()`
    SELECT * FROM missed_clock_out_cases
    WHERE employee_id = ${session.employeeId} AND business = ${session.business}
      AND clock_in >= NOW() - INTERVAL '60 days'
    ORDER BY CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END, clock_in DESC
  ` as unknown as CaseRow[];
  return rows.map(mapMissedClockOutCase);
}

export async function submitMissedClockOutTime(session: EmployeeSession, input: { id: string; leftAt: string; note?: string; now?: Date }) {
  await reconcileMissedClockOutCases();
  const rows = await getSql()`
    SELECT * FROM missed_clock_out_cases
    WHERE id = ${input.id} AND employee_id = ${session.employeeId} AND business = ${session.business}
    LIMIT 1
  ` as unknown as CaseRow[];
  const row = rows[0];
  if (!row) throw new ValidationError("That clock-out is not available.");
  if (row.status === "Resolved") throw new ValidationError("This clock-out has already been settled.");
  const clockIn = toTimestampDate(row.clock_in);
  const leftAt = parseEasternInput(input.leftAt);
  const now = input.now ?? new Date();
  const problem = clockIn ? clockOutTimeProblem({ clockIn, clockOut: leftAt, now }) : "This punch has no clock-in time.";
  if (problem) throw new ValidationError(problem);
  const note = String(input.note || "").trim().slice(0, 1000);
  const saved = await getSql()`
    UPDATE missed_clock_out_cases SET
      status = 'Submitted', employee_left_at = ${leftAt!.toISOString()}, employee_note = ${note},
      employee_submitted_at = NOW(), updated_at = NOW()
    WHERE id = ${row.id} AND status IN ('Open', 'Submitted')
    RETURNING *
  ` as unknown as CaseRow[];
  if (!saved[0]) throw new ValidationError("This clock-out has already been settled.");

  const recipients = payrollNotifyEmails();
  let ownerNotified = false;
  if (recipients.length) {
    const email = employeeLeftAtOwnerEmail({
      business: row.business, employeeName: row.employee_name, leftAt: leftAt!, clockIn: clockIn!, note,
      link: ownerClockOutLink(row.business, String(row.id)),
    });
    try {
      ownerNotified = (await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text })).sent > 0;
    } catch (error) {
      console.error("[missed-clock-out] owner email failed", error);
    }
  }
  return { case: mapMissedClockOutCase(saved[0]), ownerNotified };
}

// ---------------------------------------------------------------------------
// Owner side

export type ClockOutChoice = "scheduled_end" | "employee_time" | "custom";

/**
 * Closes the open punch with the owner's chosen time through correctPunch
 * (time_entry_adjustments audit, the same path as payroll control) and
 * resolves the case. Runs only from an explicit POST by a signed-in owner.
 */
export async function applyMissedClockOut(input: { id: string; business: Business; choice: ClockOutChoice; customTime?: string; actor: string; now?: Date }) {
  await reconcileMissedClockOutCases();
  const rows = await getSql()`SELECT * FROM missed_clock_out_cases WHERE id = ${input.id} AND business = ${input.business} LIMIT 1` as unknown as CaseRow[];
  const row = rows[0];
  if (!row) throw new ValidationError("That missed clock-out was not found.");
  if (row.status === "Resolved") throw new ValidationError("This clock-out was already settled.");
  const entries = await getSql()`
    SELECT id, clock_in, clock_out FROM time_entries WHERE id = ${row.time_entry_id} AND business = ${input.business} LIMIT 1
  ` as unknown as Array<{ id: string; clock_in: string; clock_out: string | null }>;
  const entry = entries[0];
  if (!entry) throw new ValidationError("The punch for this clock-out no longer exists.");
  if (entry.clock_out) throw new ValidationError("This punch was already clocked out.");
  const clockIn = toTimestampDate(entry.clock_in);
  if (!clockIn) throw new ValidationError("This punch has no clock-in time.");

  let clockOut: Date | null;
  let label: string;
  if (input.choice === "scheduled_end") {
    clockOut = toTimestampDate(row.scheduled_end);
    if (!clockOut) throw new ValidationError("There is no published shift end for this punch. Enter a time instead.");
    label = "used the scheduled shift end";
  } else if (input.choice === "employee_time") {
    clockOut = toTimestampDate(row.employee_left_at);
    if (!clockOut) throw new ValidationError("The employee has not entered a time yet.");
    label = "used the time the employee entered";
  } else {
    clockOut = parseEasternInput(String(input.customTime || ""));
    // A time typed earlier than the clock-in most likely means after midnight.
    if (clockOut && clockOut <= clockIn) {
      const nextDay = new Date(clockOut.getTime() + 24 * 3_600_000);
      if (nextDay.getTime() - clockIn.getTime() <= MAX_OWNER_SHIFT_HOURS * 3_600_000) clockOut = nextDay;
    }
    label = "entered by the owner";
  }
  const problem = clockOutTimeProblem({ clockIn, clockOut, now: input.now ?? new Date(), maxHours: MAX_OWNER_SHIFT_HOURS });
  if (problem) throw new ValidationError(problem.replace("The time you left", "The clock-out"));

  const correction = await correctPunch({
    business: input.business,
    // "Tiki" here means the time_entries table (both businesses' clock), as payroll control uses it.
    sourceType: "Tiki",
    sourceId: String(row.time_entry_id),
    clockIn: clockIn.toISOString(),
    clockOut: clockOut!.toISOString(),
    reason: `Missed clock-out: ${label} (${formatDateTime(clockOut!)})`,
    actor: input.actor,
  });
  const saved = await getSql()`
    UPDATE missed_clock_out_cases SET
      status = 'Resolved', resolution = ${input.choice}, resolved_clock_out = ${clockOut!.toISOString()},
      resolved_by = ${input.actor}, resolved_at = NOW(), updated_at = NOW()
    WHERE id = ${row.id}
    RETURNING *
  ` as unknown as CaseRow[];
  return { case: saved[0] ? mapMissedClockOutCase(saved[0]) : null, punch: correction.punch };
}

/** Open punches and unresolved cases for a payroll week (the approval blockers). */
export async function clockOutBlockersForWeek(business: Business, weekStart: string) {
  await reconcileMissedClockOutCases();
  const bounds = payrollWeekBounds(weekStart);
  const start = bounds.start.toISOString();
  const end = bounds.end.toISOString();
  const caseRows = await getSql()`
    SELECT COUNT(*)::INTEGER AS count FROM missed_clock_out_cases
    WHERE business = ${business} AND status <> 'Resolved' AND clock_in >= ${start} AND clock_in < ${end}
  ` as unknown as Array<{ count: number }>;
  const openRows = await getSql()`
    SELECT COUNT(*)::INTEGER AS count FROM time_entries t
    WHERE t.business = ${business} AND t.clock_out IS NULL AND t.clock_in >= ${start} AND t.clock_in < ${end}
      AND NOT EXISTS (SELECT 1 FROM missed_clock_out_cases c WHERE c.time_entry_id = t.id AND c.status <> 'Resolved')
  ` as unknown as Array<{ count: number }>;
  const reviewRows = await getSql()`
    SELECT COUNT(*)::INTEGER AS count FROM time_entries
    WHERE business = ${business} AND status = 'Needs Review' AND clock_out IS NOT NULL AND clock_in >= ${start} AND clock_in < ${end}
  ` as unknown as Array<{ count: number }>;
  let openRezku = 0;
  if (business === "Corner Deli") {
    const rezku = await getSql()`
      SELECT COUNT(*)::INTEGER AS count FROM rezku_shifts
      WHERE (clock_in IS NULL OR clock_out IS NULL)
        AND COALESCE(clock_in, clock_out) >= ${start} AND COALESCE(clock_in, clock_out) < ${end}
    ` as unknown as Array<{ count: number }>;
    openRezku = Number(rezku[0]?.count || 0);
  }
  return {
    openPunches: Number(openRows[0]?.count || 0) + openRezku,
    unresolvedClockOuts: Number(caseRows[0]?.count || 0),
    needsReview: Number(reviewRows[0]?.count || 0),
  };
}


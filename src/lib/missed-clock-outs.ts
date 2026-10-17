import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import { ValidationError } from "@/lib/http";
import {
  addDays,
  autoClosedSmsText,
  autoClosePlan,
  businessDayCloseUtc,
  canonicalRezkuName,
  closeBasisLabel,
  clockOutTimeProblem,
  employeeLeftAtOwnerEmail,
  formatDateTime,
  lastScheduledEnd,
  lateClockOutSmsText,
  localDateKey,
  matchEmployeeByName,
  MAX_OWNER_SHIFT_HOURS,
  missedClockOutDecision,
  missedClockOutOwnerEmail,
  missedClockOutSmsPlan,
  missedClockOutSmsText,
  parseEasternInput,
  resolveMissedClockOutClose,
  REZKU_LOOKBACK_DAYS,
  REZKU_SMS_MAX_AGE_HOURS,
  rezkuPunchCheck,
  weekdayOf,
  type AutoCloseBasis,
  type CaseKind,
  type CloseBasis,
  type HoursWindow,
  type ShiftWindow,
} from "@/lib/missed-clock-out-rules";
import { ensurePayrollControlSchema, untrackedPayrollNames } from "@/lib/payroll-control";
import { correctPunch } from "@/lib/payroll-punch-correction";
import { payrollWeekBounds } from "@/lib/payroll-week";
import { publicTeamBaseUrl } from "@/lib/public-team-url";
import { deliverSms } from "@/lib/sms-notifications";
import { toIsoTimestamp, toTimestampDate } from "@/lib/timestamp-values";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import type { Business } from "@/lib/types";

/**
 * Forgotten clock-outs, from either clock (source-agnostic: runMissedClockOutCheck):
 *  - Corner Ops' own clock (time_entries: the new POS clock, Tiki): a punch still open an hour after its
 *    business day closed is closed automatically at the employee's scheduled end (the day's last), else
 *    at closing time, and marked Needs Review (case kind auto_closed, status AutoClosed). With neither,
 *    it stays open for the owner (kind open_punch).
 *  - Rezku (Corner Deli's punches, imported from Rezku's reports): a punch clocked out 60+ minutes after
 *    the day's last scheduled end (kind late_clock_out), worked with no scheduled shift for over an hour
 *    (kind unscheduled, owner only), or with no clock-out at all (kind open_punch).
 * Each punch gets at most one case (unique on time_entry_id / rezku_shift_id); the employee is texted
 * once (with consent) and the owner gets one summary email per business per run. Every change to a punch
 * goes through correctPunch, the same audited path (time_entry_adjustments) payroll control uses, and
 * payroll reads the corrected time_entries / rezku_shifts rows.
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
      // Rezku punches and automatic closes (2026-10): either source, a kind, and the punch's clock-out as found.
      await sql`ALTER TABLE missed_clock_out_cases ALTER COLUMN time_entry_id DROP NOT NULL`;
      await sql`ALTER TABLE missed_clock_out_cases ALTER COLUMN employee_id DROP NOT NULL`;
      await sql`ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS rezku_shift_id UUID UNIQUE REFERENCES rezku_shifts(id) ON DELETE CASCADE`;
      await sql`ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'open_punch'`;
      await sql`ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS punch_clock_out TIMESTAMPTZ`;
      await sql`ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS auto_close_basis TEXT`;
      const defs = await sql`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'missed_clock_out_cases'::regclass AND contype = 'c'
      ` as unknown as Array<{ conname: string; def: string }>;
      const def = (name: string) => defs.find((row) => row.conname === name)?.def || "";
      if (!def("missed_clock_out_cases_status_check").includes("AutoClosed")) {
        await sql`ALTER TABLE missed_clock_out_cases DROP CONSTRAINT IF EXISTS missed_clock_out_cases_status_check`;
        await sql`ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_status_check CHECK (status IN ('Open', 'AutoClosed', 'Submitted', 'Resolved'))`;
      }
      if (!def("missed_clock_out_cases_resolution_check").includes("confirmed")) {
        await sql`ALTER TABLE missed_clock_out_cases DROP CONSTRAINT IF EXISTS missed_clock_out_cases_resolution_check`;
        await sql`
          ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_resolution_check
          CHECK (resolution IN ('', 'scheduled_end', 'employee_time', 'custom', 'closed_elsewhere', 'kept', 'confirmed'))
        `;
      }
      if (!def("missed_clock_out_cases_close_basis_check").includes("none")) {
        await sql`ALTER TABLE missed_clock_out_cases DROP CONSTRAINT IF EXISTS missed_clock_out_cases_close_basis_check`;
        await sql`
          ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_close_basis_check
          CHECK (close_basis IN ('business_close', 'scheduled_end', 'max_shift', 'none'))
        `;
      }
      if (!def("missed_clock_out_cases_kind_check")) {
        await sql`
          ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_kind_check
          CHECK (kind IN ('open_punch', 'auto_closed', 'late_clock_out', 'unscheduled'))
        `;
      }
      if (!def("missed_clock_out_cases_source_check")) {
        await sql`
          ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_source_check
          CHECK ((time_entry_id IS NOT NULL) <> (rezku_shift_id IS NOT NULL))
        `;
      }
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

type CaseStatus = "Open" | "AutoClosed" | "Submitted" | "Resolved";

type CaseRow = {
  id: string;
  time_entry_id: string | null;
  rezku_shift_id: string | null;
  kind: CaseKind | null;
  business: Business;
  employee_id: string | null;
  employee_name: string;
  position: string;
  clock_in: string;
  business_date: string | Date;
  close_basis: CloseBasis;
  close_at: string;
  shift_id: string | null;
  scheduled_end: string | null;
  punch_clock_out: string | null;
  auto_close_basis: AutoCloseBasis | null;
  status: CaseStatus;
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
  too_late: "Not texted (found too long after the shift)",
  inactive: "Not texted (inactive employee)",
  not_configured: "Not texted (SMS not configured)",
  no_employee: "Not texted (no Corner Ops employee with that Rezku name)",
  no_shift: "Not texted (no scheduled shift)",
};

const KIND_LABELS: Record<CaseKind, string> = {
  open_punch: "Still clocked in",
  auto_closed: "Closed automatically",
  late_clock_out: "Clocked out late in Rezku",
  unscheduled: "Worked without a scheduled shift",
};

/** New API fields: ISO timestamps (raw PostgreSQL text never reaches these pages). */
export function mapMissedClockOutCase(row: CaseRow) {
  const kind: CaseKind = row.kind || "open_punch";
  return {
    id: String(row.id),
    timeEntryId: row.time_entry_id ? String(row.time_entry_id) : null,
    rezkuShiftId: row.rezku_shift_id ? String(row.rezku_shift_id) : null,
    source: row.rezku_shift_id ? "Rezku" : "Corner Ops clock",
    kind,
    kindLabel: KIND_LABELS[kind] || kind,
    business: row.business,
    employeeId: row.employee_id ? String(row.employee_id) : null,
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
    /** Rezku's clock-out, or where Corner Ops closed the punch. */
    punchClockOut: toIsoTimestamp(row.punch_clock_out),
    punchClockOutEastern: eastern(row.punch_clock_out),
    autoCloseBasis: row.auto_close_basis,
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

/** Open-punch cases whose punch was closed some other way (payroll correction, a later clock-out) are resolved. */
export async function reconcileMissedClockOutCases(): Promise<number> {
  await ensureMissedClockOutSchema();
  const fromClock = await getSql()`
    UPDATE missed_clock_out_cases c SET
      status = 'Resolved', resolution = 'closed_elsewhere', resolved_clock_out = t.clock_out,
      resolved_by = 'Corner Ops', resolved_at = NOW(), updated_at = NOW()
    FROM time_entries t
    WHERE t.id = c.time_entry_id AND c.kind = 'open_punch' AND c.status <> 'Resolved' AND t.clock_out IS NOT NULL
    RETURNING c.id
  ` as unknown as Array<{ id: string }>;
  const fromRezku = await getSql()`
    UPDATE missed_clock_out_cases c SET
      status = 'Resolved', resolution = 'closed_elsewhere', resolved_clock_out = r.clock_out,
      resolved_by = 'Corner Ops', resolved_at = NOW(), updated_at = NOW()
    FROM rezku_shifts r
    WHERE r.id = c.rezku_shift_id AND c.kind = 'open_punch' AND c.status <> 'Resolved' AND r.clock_out IS NOT NULL
    RETURNING c.id
  ` as unknown as Array<{ id: string }>;
  return fromClock.length + fromRezku.length;
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


type ShiftRow = { id: string; employee_id: string; employee_name: string; starts_at: string; ends_at: string };
type IdShift = ShiftWindow & { id: string };

function toShiftWindows(rows: ShiftRow[]): IdShift[] {
  return rows.flatMap((row) => {
    const startsAt = toTimestampDate(row.starts_at), endsAt = toTimestampDate(row.ends_at);
    return startsAt && endsAt ? [{ id: String(row.id), startsAt, endsAt }] : [];
  });
}

function shiftEndingAt(shifts: IdShift[], end: Date | null): string | null {
  if (!end) return null;
  return shifts.find((shift) => shift.endsAt.getTime() === end.getTime())?.id || null;
}

/** The employee's published shifts around a clock-in (a day either side). */
async function employeeShifts(business: Business, employeeId: string, clockIn: Date): Promise<IdShift[]> {
  const rows = await getSql()`
    SELECT id, employee_id, '' AS employee_name, starts_at, ends_at
    FROM schedule_shifts
    WHERE business = ${business} AND employee_id = ${employeeId} AND status = 'Published'
      AND starts_at >= ${clockIn.toISOString()}::timestamptz - INTERVAL '1 day'
      AND starts_at < ${clockIn.toISOString()}::timestamptz + INTERVAL '1 day'
    ORDER BY starts_at
  ` as unknown as ShiftRow[];
  return toShiftWindows(rows);
}

/** The two business-day closes an open punch may belong to (the clock-in's local date and the day before). */
async function closesFor(cache: Map<Business, HoursSource>, business: Business, clockIn: Date, now: Date) {
  if (!cache.has(business)) {
    const today = localDateKey(now);
    cache.set(business, await loadHours(business, addDays(today, -45), addDays(today, 1)));
  }
  const hours = cache.get(business)!;
  const clockInDate = localDateKey(clockIn);
  return [addDays(clockInDate, -1), clockInDate].map((businessDate) => ({
    businessDate,
    closeAt: businessDayCloseUtc(businessDate, windowsForDate(hours, businessDate)),
  }));
}

type NewCase = {
  source: "time_entry" | "rezku";
  sourceId: string;
  kind: CaseKind;
  status: "Open" | "AutoClosed";
  business: Business;
  employeeId: string | null;
  employeeName: string;
  position: string;
  clockIn: Date;
  businessDate: string;
  closeBasis: CloseBasis;
  closeAt: Date;
  shiftId: string | null;
  scheduledEnd: Date | null;
  punchClockOut: Date | null;
  autoCloseBasis: AutoCloseBasis | null;
  smsStatus: string;
};

/** Inserts the punch's one case; "" when it already has one (another run got there first and texts). */
async function insertCase(c: NewCase): Promise<string> {
  const id = crypto.randomUUID();
  const values = [
    c.business, c.employeeId, c.employeeName, String(c.position || "").slice(0, 100), c.clockIn.toISOString(), c.businessDate,
    c.closeBasis, c.closeAt.toISOString(), c.shiftId, c.scheduledEnd?.toISOString() || null, c.smsStatus,
    c.kind, c.status, c.punchClockOut?.toISOString() || null, c.autoCloseBasis,
  ] as const;
  const [business, employeeId, employeeName, position, clockIn, businessDate, closeBasis, closeAt, shiftId, scheduledEnd, smsStatus, kind, status, punchClockOut, autoCloseBasis] = values;
  const rows = c.source === "time_entry"
    ? await getSql()`
        INSERT INTO missed_clock_out_cases (
          id, time_entry_id, business, employee_id, employee_name, position, clock_in, business_date, close_basis, close_at,
          shift_id, scheduled_end, sms_status, kind, status, punch_clock_out, auto_close_basis
        ) VALUES (
          ${id}, ${c.sourceId}, ${business}, ${employeeId}, ${employeeName}, ${position}, ${clockIn}, ${businessDate}::date, ${closeBasis}, ${closeAt},
          ${shiftId}, ${scheduledEnd}, ${smsStatus}, ${kind}, ${status}, ${punchClockOut}, ${autoCloseBasis}
        )
        ON CONFLICT (time_entry_id) DO NOTHING
        RETURNING id
      ` as unknown as Array<{ id: string }>
    : await getSql()`
        INSERT INTO missed_clock_out_cases (
          id, rezku_shift_id, business, employee_id, employee_name, position, clock_in, business_date, close_basis, close_at,
          shift_id, scheduled_end, sms_status, kind, status, punch_clock_out, auto_close_basis
        ) VALUES (
          ${id}, ${c.sourceId}, ${business}, ${employeeId}, ${employeeName}, ${position}, ${clockIn}, ${businessDate}::date, ${closeBasis}, ${closeAt},
          ${shiftId}, ${scheduledEnd}, ${smsStatus}, ${kind}, ${status}, ${punchClockOut}, ${autoCloseBasis}
        )
        ON CONFLICT (rezku_shift_id) DO NOTHING
        RETURNING id
      ` as unknown as Array<{ id: string }>;
  return rows[0]?.id ? String(rows[0].id) : "";
}

type Recipient = { id: string; name: string; phone: string; smsOptIn: boolean };

/** Texts the employee (consent checked by the plan and again by deliverSms) and records the outcome on the case. */
async function textEmployee(caseId: string, recipient: Recipient, text: string, now: Date): Promise<string> {
  let smsStatus = "sending";
  let smsDetail = "";
  try {
    const result = await deliverSms({ recipients: [recipient], text: () => text });
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
  return smsStatus;
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
          kind: row.kind || "open_punch",
          punchClockOut: toTimestampDate(row.punch_clock_out),
          autoCloseBasis: row.auto_close_basis,
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

export const AUTO_CLOSE_ACTOR = "Corner Ops (automatic clock-out)";

type CheckOutput = {
  created: Array<Record<string, unknown>>;
  pending: Array<Record<string, unknown>>;
  errors: string[];
};

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

/**
 * Corner Ops' own clock: each punch still open an hour after its close (and an hour after the time it
 * would be closed at) is closed at the scheduled end, else closing time, through correctPunch, marked
 * Needs Review, and the employee is texted. With neither time it stays open (an open_punch case).
 */
async function checkTimeEntries(now: Date, dryRun: boolean, out: CheckOutput) {
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
  for (const entry of entries) {
    try {
      const clockIn = toTimestampDate(entry.clock_in);
      if (!clockIn) continue;
      const closes = await closesFor(hoursCache, entry.business, clockIn, now);
      const shifts = await employeeShifts(entry.business, String(entry.employee_id), clockIn);
      const scheduledEnd = lastScheduledEnd({ clockIn, clockOut: null, shifts });
      const close = resolveMissedClockOutClose({ clockIn, closes, scheduledEnd });
      const plan = autoClosePlan({ clockIn, scheduledEnd, businessCloseAt: close.basis === "business_close" ? close.closeAt : null, dueAt: close.dueAt });
      const dueAt = plan?.dueAt ?? close.dueAt;
      const decision = missedClockOutDecision({ now, dueAt, hasCase: false, clockedOut: false });
      const summary = {
        source: "time_entries", timeEntryId: String(entry.id), business: entry.business, employeeName: entry.employee_name,
        clockIn: clockIn.toISOString(), closeBasis: close.basis, closeAt: close.closeAt.toISOString(), dueAt: dueAt.toISOString(),
        scheduledEnd: scheduledEnd?.toISOString() || null, autoCloseAt: plan?.closeAt.toISOString() || null, autoCloseBasis: plan?.basis || null,
      };
      if (decision !== "create") {
        out.pending.push(summary);
        continue;
      }
      const smsPlan = missedClockOutSmsPlan({
        now, dueAt, smsOptIn: Boolean(entry.sms_opt_in), phone: String(entry.phone || ""), active: entry.active !== false,
      });
      if (dryRun) {
        out.created.push({ ...summary, kind: plan ? "auto_closed" : "open_punch", wouldText: smsPlan.send, smsSkipReason: smsPlan.send ? "" : smsPlan.reason });
        continue;
      }
      const caseId = await insertCase({
        source: "time_entry", sourceId: String(entry.id), kind: plan ? "auto_closed" : "open_punch", status: plan ? "AutoClosed" : "Open",
        business: entry.business, employeeId: String(entry.employee_id), employeeName: entry.employee_name, position: entry.position,
        clockIn, businessDate: close.businessDate, closeBasis: close.basis, closeAt: close.closeAt,
        shiftId: shiftEndingAt(shifts, scheduledEnd), scheduledEnd, punchClockOut: plan?.closeAt || null, autoCloseBasis: plan?.basis || null,
        smsStatus: smsPlan.send ? "sending" : smsPlan.reason,
      });
      if (!caseId) continue; // Another run created it first; that run texts.
      // Claim the punch for review; it must still be open (the employee may have just clocked out).
      const claimed = await getSql()`
        UPDATE time_entries SET status = 'Needs Review', updated_at = NOW()
        WHERE id = ${entry.id} AND clock_out IS NULL
        RETURNING id
      ` as unknown as Array<{ id: string }>;
      if (!claimed[0]) {
        await getSql()`
          UPDATE missed_clock_out_cases SET status = 'Resolved', resolution = 'closed_elsewhere', resolved_by = 'Corner Ops',
            resolved_at = NOW(), kind = 'open_punch', punch_clock_out = NULL, auto_close_basis = NULL, updated_at = NOW()
          WHERE id = ${caseId}
        `;
        continue;
      }
      let autoClosed = false;
      if (plan) {
        try {
          await correctPunch({
            business: entry.business,
            // "Tiki" here means the time_entries table (both businesses' clock), as payroll control uses it.
            sourceType: "Tiki",
            sourceId: String(entry.id),
            clockIn: clockIn.toISOString(),
            clockOut: plan.closeAt.toISOString(),
            reason: `Missed clock-out: closed automatically at the ${plan.basis === "scheduled_end" ? "scheduled end" : "closing time"} (${formatDateTime(plan.closeAt)}); needs review`,
            actor: AUTO_CLOSE_ACTOR,
          });
          await getSql()`UPDATE time_entries SET status = 'Needs Review', updated_at = NOW() WHERE id = ${entry.id}`;
          autoClosed = true;
        } catch (error) {
          out.errors.push(`${entry.employee_name}: couldn't close the punch automatically: ${error instanceof Error ? error.message : String(error)}`);
          await getSql()`
            UPDATE missed_clock_out_cases SET kind = 'open_punch', status = 'Open', punch_clock_out = NULL, auto_close_basis = NULL, updated_at = NOW()
            WHERE id = ${caseId}
          `;
        }
      }
      let smsStatus = smsPlan.send ? "sending" : smsPlan.reason;
      if (smsPlan.send) {
        const link = employeeClockOutLink(entry.business, caseId);
        const text = autoClosed && plan
          ? autoClosedSmsText({ employeeName: entry.employee_name, business: entry.business, clockIn, closedAt: plan.closeAt, basis: plan.basis, link })
          : missedClockOutSmsText({ employeeName: entry.employee_name, business: entry.business, clockIn, now, link });
        smsStatus = await textEmployee(caseId, { id: String(entry.employee_id), name: entry.employee_name, phone: String(entry.phone || ""), smsOptIn: Boolean(entry.sms_opt_in) }, text, now);
      }
      out.created.push({ ...summary, kind: autoClosed ? "auto_closed" : "open_punch", caseId, smsStatus });
    } catch (error) {
      out.errors.push(`${entry.employee_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return entries.length;
}

type RezkuRow = { id: string; employee_name: string; position: string; clock_in: string; clock_out: string | null };
type EmployeeRow = { id: string; name: string; phone: string | null; sms_opt_in: boolean | null; active: boolean | null };

/**
 * Rezku punches (Corner Deli): late clock-outs (60+ minutes past the day's last scheduled end) are texted
 * (within 48 hours of the clock-out); unscheduled ones over an hour go to the owner only; punches with no
 * clock-out are handled like open time clock punches (never closed automatically). Salaried employees and
 * owners are skipped except for open punches. Punches are matched to the schedule and to employees by name,
 * as payroll does ("Can" is Ken).
 */
async function checkRezku(now: Date, dryRun: boolean, options: MissedClockOutCheckOptions, out: CheckOutput) {
  const business: Business = "Corner Deli";
  const from = options.rezkuFrom ?? new Date(now.getTime() - REZKU_LOOKBACK_DAYS * 24 * 3_600_000);
  const to = options.rezkuTo ?? now;
  const batchId = options.rezkuBatchId ? String(options.rezkuBatchId) : null;
  const rows = await getSql()`
    SELECT r.id, r.employee_name, r.position, r.clock_in, r.clock_out
    FROM rezku_shifts r
    LEFT JOIN missed_clock_out_cases c ON c.rezku_shift_id = r.id
    WHERE c.id IS NULL AND r.clock_in IS NOT NULL
      AND r.clock_in >= ${from.toISOString()}::timestamptz AND r.clock_in < ${to.toISOString()}::timestamptz
      AND r.clock_in <= ${now.toISOString()}::timestamptz - INTERVAL '60 minutes'
      AND (r.clock_out IS NULL OR r.clock_out <= ${now.toISOString()}::timestamptz)
      AND (${batchId}::text IS NULL OR r.batch_id::text = ${batchId}::text)
      AND LOWER(BTRIM(r.employee_name)) NOT IN ('', 'cover', 'unallocated')
    ORDER BY r.clock_in
    LIMIT 500
  ` as unknown as RezkuRow[];
  if (!rows.length) return 0;
  const first = toTimestampDate(rows[0].clock_in) || from;
  const last = toTimestampDate(rows[rows.length - 1].clock_in) || to;
  const [employees, shiftRows, untracked] = await Promise.all([
    getSql()`SELECT id, name, phone, sms_opt_in, active FROM employees WHERE business = ${business}` as unknown as Promise<EmployeeRow[]>,
    getSql()`
      SELECT s.id, s.employee_id, e.name AS employee_name, s.starts_at, s.ends_at
      FROM schedule_shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.business = ${business} AND s.status = 'Published'
        AND s.starts_at >= ${first.toISOString()}::timestamptz - INTERVAL '1 day'
        AND s.starts_at < ${last.toISOString()}::timestamptz + INTERVAL '2 days'
    ` as unknown as Promise<ShiftRow[]>,
    untrackedPayrollNames(business),
  ]);
  const byName = new Map<string, IdShift[]>();
  for (const row of shiftRows) {
    const key = canonicalRezkuName(row.employee_name).toLowerCase();
    byName.set(key, [...(byName.get(key) || []), ...toShiftWindows([row])]);
  }
  const salaried = new Set(untracked.map((name) => canonicalRezkuName(name).toLowerCase()));
  const people = employees.map((e) => ({ ...e, name: String(e.name || ""), active: e.active !== false }));
  const hoursCache = new Map<Business, HoursSource>();

  for (const row of rows) {
    const name = canonicalRezkuName(row.employee_name);
    try {
      const clockIn = toTimestampDate(row.clock_in);
      if (!clockIn) continue;
      const clockOut = toTimestampDate(row.clock_out);
      const key = name.toLowerCase();
      const shifts = byName.get(key) || [];
      const check = rezkuPunchCheck({ clockIn, clockOut, shifts });
      if (check.kind === "ok") continue;
      if (check.kind !== "open" && salaried.has(key)) continue;
      const employee = matchEmployeeByName(name, people);
      const recipient = employee ? { id: String(employee.id), name, phone: String(employee.phone || ""), smsOptIn: Boolean(employee.sms_opt_in) } : null;

      let fields: Omit<NewCase, "source" | "sourceId" | "business" | "employeeId" | "employeeName" | "position" | "clockIn" | "smsStatus" | "status">;
      let dueAt: Date;
      let maxLatenessHours: number | undefined;
      let text: ((link: string) => string) | null = null;
      if (check.kind === "open") {
        const closes = await closesFor(hoursCache, business, clockIn, now);
        const scheduledEnd = lastScheduledEnd({ clockIn, clockOut: null, shifts });
        const close = resolveMissedClockOutClose({ clockIn, closes, scheduledEnd });
        if (missedClockOutDecision({ now, dueAt: close.dueAt, hasCase: false, clockedOut: false }) !== "create") {
          out.pending.push({ source: "rezku", rezkuShiftId: String(row.id), employeeName: name, clockIn: clockIn.toISOString(), dueAt: close.dueAt.toISOString() });
          continue;
        }
        dueAt = close.dueAt;
        fields = { kind: "open_punch", businessDate: close.businessDate, closeBasis: close.basis, closeAt: close.closeAt, shiftId: shiftEndingAt(shifts, scheduledEnd), scheduledEnd, punchClockOut: null, autoCloseBasis: null };
        text = (link) => missedClockOutSmsText({ employeeName: name, business, clockIn, now, link });
      } else if (check.kind === "late") {
        dueAt = clockOut!;
        maxLatenessHours = REZKU_SMS_MAX_AGE_HOURS;
        fields = { kind: "late_clock_out", businessDate: localDateKey(clockIn), closeBasis: "scheduled_end", closeAt: check.scheduledEnd, shiftId: shiftEndingAt(shifts, check.scheduledEnd), scheduledEnd: check.scheduledEnd, punchClockOut: clockOut, autoCloseBasis: null };
        text = (link) => lateClockOutSmsText({ employeeName: name, clockOut: clockOut!, scheduledEnd: check.scheduledEnd, link });
      } else {
        dueAt = clockOut!;
        fields = { kind: "unscheduled", businessDate: localDateKey(clockIn), closeBasis: "none", closeAt: clockOut!, shiftId: null, scheduledEnd: null, punchClockOut: clockOut, autoCloseBasis: null };
      }
      const plan = !text
        ? { send: false as const, reason: "no_shift" }
        : !recipient
          ? { send: false as const, reason: "no_employee" }
          : missedClockOutSmsPlan({ now, dueAt, smsOptIn: recipient.smsOptIn, phone: recipient.phone, active: employee!.active, maxLatenessHours });
      const summary = {
        source: "rezku", rezkuShiftId: String(row.id), kind: fields.kind, employeeName: name, clockIn: clockIn.toISOString(),
        clockOut: clockOut?.toISOString() || null, scheduledEnd: fields.scheduledEnd?.toISOString() || null,
      };
      if (dryRun) {
        out.created.push({ ...summary, wouldText: plan.send, smsSkipReason: plan.send ? "" : plan.reason });
        continue;
      }
      const caseId = await insertCase({
        ...fields, source: "rezku", sourceId: String(row.id), status: "Open", business, employeeId: employee ? String(employee.id) : null,
        employeeName: name, position: row.position, clockIn, smsStatus: plan.send ? "sending" : plan.reason,
      });
      if (!caseId) continue;
      const smsStatus = plan.send && text && recipient ? await textEmployee(caseId, recipient, text(employeeClockOutLink(business, caseId)), now) : (plan.send ? "sending" : plan.reason);
      out.created.push({ ...summary, caseId, smsStatus });
    } catch (error) {
      out.errors.push(`${name} (Rezku): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return rows.length;
}

export type MissedClockOutCheckOptions = {
  now?: Date;
  /** Report what would happen without saving, closing, texting or emailing anything. */
  dryRun?: boolean;
  /** Which clocks to check (default both). */
  sources?: Array<"time_entries" | "rezku">;
  /** Only the Rezku punches of this import batch (rezku_shifts.batch_id). */
  rezkuBatchId?: string;
  /** Rezku punches whose clock-in is in [rezkuFrom, rezkuTo) (default: the last REZKU_LOOKBACK_DAYS days). */
  rezkuFrom?: Date;
  rezkuTo?: Date;
};

/**
 * The forgotten clock-out check, for both clocks. Runs every 15 minutes (/api/cron/missed-clock-outs) and
 * should also run right after punches are imported: after a Rezku shifts import, call
 *   await runMissedClockOutCheck({ sources: ["rezku"], rezkuBatchId: batchId })
 * (or rezkuFrom / rezkuTo for a date range). Idempotent: each punch gets at most one case, one text and
 * one line in one owner email.
 */
export async function runMissedClockOutCheck(options: MissedClockOutCheckOptions = {}) {
  await ensureMissedClockOutSchema();
  const now = options.now ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const sources = options.sources?.length ? options.sources : ["time_entries", "rezku"];
  const reconciled = dryRun ? 0 : await reconcileMissedClockOutCases();
  const out: CheckOutput = { created: [], pending: [], errors: [] };
  const openPunches = sources.includes("time_entries") ? await checkTimeEntries(now, dryRun, out) : 0;
  const rezkuChecked = sources.includes("rezku") ? await checkRezku(now, dryRun, options, out) : 0;
  const ownerEmails = dryRun ? {} : await sendOwnerSummaries(now);
  return { dryRun, checkedAt: now.toISOString(), reconciled, openPunches, rezkuChecked, ...out, ownerEmails };
}

/** The 15-minute job's name before Rezku punches were checked too. */
export const runMissedClockOuts = runMissedClockOutCheck;

// ---------------------------------------------------------------------------
// Reading cases

export async function missedClockOutCasesForBusiness(business: Business, options: { weekStart?: string; includeResolved?: boolean } = {}) {
  await reconcileMissedClockOutCases();
  const bounds = options.weekStart ? payrollWeekBounds(options.weekStart) : null;
  const rows = bounds
    ? await getSql()`
        SELECT * FROM missed_clock_out_cases
        WHERE business = ${business} AND clock_in >= ${bounds.start.toISOString()} AND clock_in < ${bounds.end.toISOString()}
        ORDER BY CASE status WHEN 'Submitted' THEN 0 WHEN 'Open' THEN 1 WHEN 'AutoClosed' THEN 2 ELSE 3 END, clock_in DESC
      ` as unknown as CaseRow[]
    : await getSql()`
        SELECT * FROM missed_clock_out_cases
        WHERE business = ${business}
          AND (status <> 'Resolved' OR (${Boolean(options.includeResolved)}::boolean AND clock_in >= NOW() - INTERVAL '60 days'))
        ORDER BY CASE status WHEN 'Submitted' THEN 0 WHEN 'Open' THEN 1 WHEN 'AutoClosed' THEN 2 ELSE 3 END, clock_in DESC
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
    WHERE employee_id = ${session.employeeId} AND business = ${session.business} AND kind <> 'unscheduled'
      AND clock_in >= NOW() - INTERVAL '60 days'
    ORDER BY CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END, clock_in DESC
  ` as unknown as CaseRow[];
  return rows.map(mapMissedClockOutCase);
}

async function employeeCase(session: EmployeeSession, id: string): Promise<CaseRow> {
  await reconcileMissedClockOutCases();
  const rows = await getSql()`
    SELECT * FROM missed_clock_out_cases
    WHERE id = ${id} AND employee_id = ${session.employeeId} AND business = ${session.business} AND kind <> 'unscheduled'
    LIMIT 1
  ` as unknown as CaseRow[];
  const row = rows[0];
  if (!row) throw new ValidationError("That clock-out is not available.");
  if (row.status === "Resolved") throw new ValidationError("This clock-out has already been settled.");
  return row;
}

export async function submitMissedClockOutTime(session: EmployeeSession, input: { id: string; leftAt: string; note?: string; now?: Date }) {
  const row = await employeeCase(session, input.id);
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
    WHERE id = ${row.id} AND status IN ('Open', 'AutoClosed', 'Submitted')
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

/**
 * "That's right": the employee confirms the clock-out on the punch (Rezku's, or where Corner Ops closed it),
 * which settles the case without changing the punch.
 */
export async function confirmMissedClockOut(session: EmployeeSession, input: { id: string }) {
  const row = await employeeCase(session, input.id);
  if (row.kind !== "late_clock_out" && row.kind !== "auto_closed") throw new ValidationError("There's no clock-out to confirm yet. Enter the time you left.");
  const saved = await getSql()`
    UPDATE missed_clock_out_cases SET
      status = 'Resolved', resolution = 'confirmed', resolved_clock_out = punch_clock_out,
      resolved_by = ${`${row.employee_name} (employee)`}, resolved_at = NOW(), updated_at = NOW()
    WHERE id = ${row.id} AND status <> 'Resolved'
    RETURNING *
  ` as unknown as CaseRow[];
  if (!saved[0]) throw new ValidationError("This clock-out has already been settled.");
  if (row.time_entry_id) {
    await getSql()`UPDATE time_entries SET status = 'Corrected', updated_at = NOW() WHERE id = ${row.time_entry_id} AND status = 'Needs Review' AND clock_out IS NOT NULL`;
  }
  return { case: mapMissedClockOutCase(saved[0]) };
}

// ---------------------------------------------------------------------------
// Owner side

export type ClockOutChoice = "scheduled_end" | "employee_time" | "custom" | "keep";

/**
 * Settles a case with the owner's choice. A new clock-out goes through correctPunch (time_entry_adjustments
 * audit, the same path payroll control uses, on time_entries or rezku_shifts); "keep" leaves the punch as
 * it is (Rezku's clock-out, or the automatic close). Runs only from an explicit POST by a signed-in owner.
 */
export async function applyMissedClockOut(input: { id: string; business: Business; choice: ClockOutChoice; customTime?: string; actor: string; now?: Date }) {
  await reconcileMissedClockOutCases();
  const rows = await getSql()`SELECT * FROM missed_clock_out_cases WHERE id = ${input.id} AND business = ${input.business} LIMIT 1` as unknown as CaseRow[];
  const row = rows[0];
  if (!row) throw new ValidationError("That missed clock-out was not found.");
  if (row.status === "Resolved") throw new ValidationError("This clock-out was already settled.");
  const kind: CaseKind = row.kind || "open_punch";
  const fromRezku = Boolean(row.rezku_shift_id);
  const punches = fromRezku
    ? await getSql()`SELECT id, clock_in, clock_out FROM rezku_shifts WHERE id = ${row.rezku_shift_id} LIMIT 1` as unknown as Array<{ id: string; clock_in: string; clock_out: string | null }>
    : await getSql()`SELECT id, clock_in, clock_out FROM time_entries WHERE id = ${row.time_entry_id} AND business = ${input.business} LIMIT 1` as unknown as Array<{ id: string; clock_in: string; clock_out: string | null }>;
  const punch = punches[0];
  if (!punch) throw new ValidationError("The punch for this clock-out no longer exists.");
  if (kind === "open_punch" && punch.clock_out) throw new ValidationError("This punch was already clocked out.");
  const clockIn = toTimestampDate(punch.clock_in);
  if (!clockIn) throw new ValidationError("This punch has no clock-in time.");

  if (input.choice === "keep") {
    const current = toTimestampDate(punch.clock_out);
    if (!current) throw new ValidationError("This punch has no clock-out to keep. Choose a time.");
    if (!fromRezku) await getSql()`UPDATE time_entries SET status = 'Corrected', updated_at = NOW() WHERE id = ${punch.id} AND status = 'Needs Review'`;
    const kept = await getSql()`
      UPDATE missed_clock_out_cases SET status = 'Resolved', resolution = 'kept', resolved_clock_out = ${current.toISOString()},
        resolved_by = ${input.actor}, resolved_at = NOW(), updated_at = NOW()
      WHERE id = ${row.id} AND status <> 'Resolved'
      RETURNING *
    ` as unknown as CaseRow[];
    return { case: kept[0] ? mapMissedClockOutCase(kept[0]) : null, punch: { id: punch.id, clockIn: punch.clock_in, clockOut: punch.clock_out } };
  }

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
    // "Tiki" = the time_entries table (both businesses' clock); "Rezku" = rezku_shifts, which Corner Deli payroll reads.
    sourceType: fromRezku ? "Rezku" : "Tiki",
    sourceId: String(punch.id),
    clockIn: clockIn.toISOString(),
    clockOut: clockOut!.toISOString(),
    reason: `${kind === "late_clock_out" ? "Late Rezku clock-out" : kind === "unscheduled" ? "Unscheduled Rezku punch" : "Missed clock-out"}: ${label} (${formatDateTime(clockOut!)})`,
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

/**
 * The week's approval blockers: open punches (either clock) and cases that block approval (a punch still
 * open, or a time an employee sent that the owner hasn't decided on). clockOutsToCheck counts the other
 * unsettled cases (automatically closed, late or unscheduled Rezku punches), which don't block.
 */
export async function clockOutBlockersForWeek(business: Business, weekStart: string) {
  await reconcileMissedClockOutCases();
  const bounds = payrollWeekBounds(weekStart);
  const start = bounds.start.toISOString();
  const end = bounds.end.toISOString();
  const caseRows = await getSql()`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Submitted' OR kind = 'open_punch')::INTEGER AS blocking,
      COUNT(*) FILTER (WHERE status <> 'Submitted' AND kind <> 'open_punch')::INTEGER AS to_check
    FROM missed_clock_out_cases
    WHERE business = ${business} AND status <> 'Resolved' AND clock_in >= ${start} AND clock_in < ${end}
  ` as unknown as Array<{ blocking: number; to_check: number }>;
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
      SELECT COUNT(*)::INTEGER AS count FROM rezku_shifts r
      WHERE (r.clock_in IS NULL OR r.clock_out IS NULL)
        AND COALESCE(r.clock_in, r.clock_out) >= ${start} AND COALESCE(r.clock_in, r.clock_out) < ${end}
        AND NOT EXISTS (SELECT 1 FROM missed_clock_out_cases c WHERE c.rezku_shift_id = r.id AND c.status <> 'Resolved')
    ` as unknown as Array<{ count: number }>;
    openRezku = Number(rezku[0]?.count || 0);
  }
  return {
    openPunches: Number(openRows[0]?.count || 0) + openRezku,
    unresolvedClockOuts: Number(caseRows[0]?.blocking || 0),
    needsReview: Number(reviewRows[0]?.count || 0),
    clockOutsToCheck: Number(caseRows[0]?.to_check || 0),
  };
}

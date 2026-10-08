import { getSql } from "@/lib/db";
import { ValidationError } from "@/lib/http";
import {
  clockOutBlockersForWeek,
  ensureMissedClockOutSchema,
  missedClockOutCasesForBusiness,
  payrollNotifyEmails,
} from "@/lib/missed-clock-outs";
import {
  payrollApprovalBlockMessage,
  payrollApprovalEmail,
  payrollCodeEmail,
  payrollSubmissionEmail,
  submissionStatusLine,
  type SubmissionStatus,
} from "@/lib/missed-clock-out-rules";
import {
  controlledPayrollSummary,
  createPayrollDraft,
  lockPayrollRun,
  payrollCsv,
  reopenPayrollRun,
  scheduleComparisonFor,
} from "@/lib/payroll-control";
import { payrollDisplayRows, type ScheduleComparison, type WorkedRowInput } from "@/lib/payroll-schedule-compare";
import {
  employeeKey,
  formatTotals,
  guessRosterMatches,
  rosterDisplayName,
  type HoursTotals,
  type RosterEntry,
} from "@/lib/payroll-relief-timesheet";
import { publicTeamBaseUrl } from "@/lib/public-team-url";
import { toIsoTimestamp } from "@/lib/timestamp-values";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import type { Business } from "@/lib/types";
import { addDateKeyDays, currentPayrollWeekStart, payrollWeekBounds } from "@/lib/payroll-week";

/**
 * Monday payroll approval and the AccountantsOffice (Payroll Relief) queue.
 * Approving is the existing lock (lockPayrollRun), refused while the week has
 * open punches or unresolved missed clock-outs. Each Corner Deli lock queues one
 * submission; the store server's job (deploy/supplier-scraper/payroll-relief.mjs)
 * takes queued ones from /api/cron/payroll-submissions, enters the hours and tips
 * in Payroll Relief and SAVES them (it never submits: the owner reviews and
 * presses Submit there), and reports the outcome. "submitted" in this table means
 * saved for review. The Docks (Tiki, a separate company) is never sent.
 * A "roster" row is a Check AccountantsOffice request: the job only downloads
 * the timesheet and reports Payroll Relief's employee list.
 */

/** Only Corner Deli's payroll is entered in Payroll Relief. */
export const PAYROLL_RELIEF_BUSINESS: Business = "Corner Deli";
export const DOCKS_NOT_SENT = "The Docks isn't sent to AccountantsOffice automatically.";

let schemaPromise: Promise<void> | null = null;

export function ensurePayrollApprovalSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureMissedClockOutSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS payroll_submissions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          week_start DATE NOT NULL,
          payroll_run_version_id UUID NOT NULL UNIQUE REFERENCES payroll_run_versions(id),
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitting', 'submitted', 'failed', 'cancelled')),
          message TEXT NOT NULL DEFAULT '',
          attempts INTEGER NOT NULL DEFAULT 0,
          queued_by TEXT NOT NULL DEFAULT '',
          queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          confirmation_emailed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      // Payroll Relief job: a texted sign-in code step, Check AccountantsOffice requests (kind roster, no payroll run), totals saved.
      await sql`ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'payroll'`;
      await sql`ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS code TEXT`;
      await sql`ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS code_at TIMESTAMPTZ`;
      await sql`ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS code_emailed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS totals JSONB`;
      await sql`ALTER TABLE payroll_submissions ALTER COLUMN payroll_run_version_id DROP NOT NULL`;
      await sql`ALTER TABLE payroll_submissions ALTER COLUMN week_start DROP NOT NULL`;
      const checks = await sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'payroll_submissions'::regclass AND conname = 'payroll_submissions_status_check'
      ` as unknown as Array<{ def: string }>;
      if (!checks[0] || !checks[0].def.includes("needs_code")) {
        await sql`ALTER TABLE payroll_submissions DROP CONSTRAINT IF EXISTS payroll_submissions_status_check`;
        await sql`
          ALTER TABLE payroll_submissions ADD CONSTRAINT payroll_submissions_status_check
          CHECK (status IN ('queued', 'submitting', 'needs_code', 'submitted', 'failed', 'cancelled'))
        `;
      }
      const kindChecks = await sql`
        SELECT 1 AS present FROM pg_constraint WHERE conrelid = 'payroll_submissions'::regclass AND conname = 'payroll_submissions_kind_check'
      ` as unknown as Array<{ present: number }>;
      if (!kindChecks[0]) {
        await sql`
          ALTER TABLE payroll_submissions ADD CONSTRAINT payroll_submissions_kind_check
          CHECK ((kind = 'payroll' AND payroll_run_version_id IS NOT NULL AND week_start IS NOT NULL) OR kind = 'roster')
        `;
      }
      // Payroll Relief's employees as the job last saw them in the timesheet download.
      await sql`
        CREATE TABLE IF NOT EXISTS payroll_relief_roster (
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          ee_num TEXT NOT NULL,
          name TEXT NOT NULL,
          pay_type TEXT NOT NULL DEFAULT '',
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (business, ee_num)
        )
      `;
      // Which Payroll Relief employee (EE #) each Corner Ops payroll name is, as confirmed by the owner.
      await sql`
        CREATE TABLE IF NOT EXISTS payroll_relief_employees (
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_key TEXT NOT NULL,
          employee_name TEXT NOT NULL,
          ee_num TEXT NOT NULL,
          confirmed_by TEXT NOT NULL DEFAULT '',
          confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (business, employee_key)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS payroll_submissions_status_idx ON payroll_submissions (status, queued_at)`;
      await sql`CREATE INDEX IF NOT EXISTS payroll_submissions_week_idx ON payroll_submissions (business, week_start DESC)`;
      // One row per notice actually sent (the Monday approval email), so retries never send twice.
      await sql`
        CREATE TABLE IF NOT EXISTS payroll_week_notices (
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          week_start DATE NOT NULL,
          kind TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (business, week_start, kind)
        )
      `;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export function payrollControlLink(business: Business, weekStart: string): string {
  return `${publicTeamBaseUrl(business)}/ops/payroll-control?business=${encodeURIComponent(business)}&weekStart=${encodeURIComponent(weekStart)}`;
}

function weekText(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
}

async function audit(business: Business, eventType: string, referenceId: string, details: Record<string, unknown>, actor: string) {
  await getSql()`
    INSERT INTO payroll_audit_events (id, business, event_type, reference_id, details, actor)
    VALUES (${crypto.randomUUID()}, ${business}, ${eventType}, ${referenceId}, ${JSON.stringify(details)}::jsonb, ${actor})
  `;
}

export async function payrollApprovalBlockers(business: Business, weekStart: string) {
  await ensurePayrollApprovalSchema();
  const blockers = await clockOutBlockersForWeek(business, weekStart);
  return { ...blockers, message: payrollApprovalBlockMessage(blockers) };
}

/** Approve = lock, refused with a clear message while the week still has open punches or missed clock-outs. */
export async function approvePayrollRun(input: { id: string; business: Business; actor: string }) {
  await ensurePayrollApprovalSchema();
  const runs = await getSql()`
    SELECT id, business, week_start, version, status FROM payroll_run_versions WHERE id = ${input.id} LIMIT 1
  ` as unknown as Array<{ id: string; business: Business; week_start: string | Date; version: number; status: string }>;
  const run = runs[0];
  if (!run || run.business !== input.business) throw new ValidationError("That payroll version was not found for this business.");
  if (run.status !== "Draft") throw new ValidationError("Only a draft payroll version can be approved.");
  const weekStart = weekText(run.week_start);
  const blockers = await payrollApprovalBlockers(input.business, weekStart);
  if (blockers.message) throw new ValidationError(blockers.message);
  const locked = await lockPayrollRun(input.id, input.actor);
  // The Docks is a separate company (and closed for the season): it is never entered automatically.
  if (input.business !== PAYROLL_RELIEF_BUSINESS) return { ...locked, submission: null, submissionNote: DOCKS_NOT_SENT };
  const submission = await queuePayrollSubmission({ runId: input.id, business: input.business, weekStart, actor: input.actor });
  return { ...locked, submission };
}

export async function queuePayrollSubmission(input: { runId: string; business: Business; weekStart: string; actor: string }) {
  if (input.business !== PAYROLL_RELIEF_BUSINESS) return null;
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    INSERT INTO payroll_submissions (id, business, week_start, payroll_run_version_id, queued_by)
    VALUES (${crypto.randomUUID()}, ${input.business}, ${input.weekStart}::date, ${input.runId}, ${input.actor})
    ON CONFLICT (payroll_run_version_id) DO NOTHING
    RETURNING id, status
  ` as unknown as Array<{ id: string; status: string }>;
  if (rows[0]) await audit(input.business, "Payroll Submission Queued", input.runId, { weekStart: input.weekStart, submissionId: rows[0].id, destination: "AccountantsOffice" }, input.actor);
  return rows[0] ? { id: String(rows[0].id), status: rows[0].status, statusLine: submissionStatusLine(rows[0].status) } : null;
}

/** Reopening a locked run withdraws a submission that has not been taken yet. */
export async function reopenPayrollRunAndWithdraw(input: { id: string; business: Business; actor: string }) {
  await ensurePayrollApprovalSchema();
  const runs = await getSql()`SELECT business FROM payroll_run_versions WHERE id = ${input.id} LIMIT 1` as unknown as Array<{ business: Business }>;
  if (!runs[0] || runs[0].business !== input.business) throw new ValidationError("That payroll version was not found for this business.");
  const reopened = await reopenPayrollRun(input.id, input.actor);
  const cancelled = await getSql()`
    UPDATE payroll_submissions SET status = 'cancelled', message = 'Payroll was reopened before it was sent.', finished_at = NOW(), updated_at = NOW()
    WHERE payroll_run_version_id = ${input.id} AND status IN ('queued', 'failed')
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  return { ...reopened, submissionCancelled: cancelled.length > 0 };
}

/** The owner asks to try a failed submission again. */
export async function retryPayrollSubmission(input: { id: string; business: Business; actor: string }) {
  await ensurePayrollApprovalSchema();
  if (input.business !== PAYROLL_RELIEF_BUSINESS) throw new ValidationError(DOCKS_NOT_SENT);
  const rows = await getSql()`
    UPDATE payroll_submissions s SET status = 'queued', message = '', queued_at = NOW(), queued_by = ${input.actor},
      started_at = NULL, finished_at = NULL, confirmation_emailed_at = NULL, code = NULL, code_at = NULL, code_emailed_at = NULL,
      totals = NULL, updated_at = NOW()
    FROM payroll_run_versions r
    WHERE s.id::text = ${input.id} AND s.business = ${input.business} AND s.kind = 'payroll' AND s.status IN ('failed', 'submitted')
      AND r.id = s.payroll_run_version_id AND r.status = 'Locked'
    RETURNING s.id, s.payroll_run_version_id
  ` as unknown as Array<{ id: string; payroll_run_version_id: string }>;
  if (!rows[0]) throw new ValidationError("Only a failed (or already saved) submission of a locked payroll can be sent again.");
  await audit(input.business, "Payroll Submission Retried", String(rows[0].payroll_run_version_id), { submissionId: input.id }, input.actor);
  return { id: input.id, status: "queued", statusLine: submissionStatusLine("queued") };
}

type SubmissionRow = {
  id: string;
  kind: "payroll" | "roster";
  business: Business;
  week_start: string | Date | null;
  payroll_run_version_id: string | null;
  totals: HoursTotals | null;
  status: SubmissionStatus;
  message: string;
  attempts: number;
  queued_by: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  version?: number;
};

function mapSubmission(row: SubmissionRow) {
  return {
    id: String(row.id),
    kind: row.kind || "payroll",
    business: row.business,
    weekStart: row.week_start ? weekText(row.week_start) : null,
    payrollRunVersionId: row.payroll_run_version_id ? String(row.payroll_run_version_id) : null,
    version: row.version === undefined || row.version === null ? null : Number(row.version),
    status: row.status,
    statusLine: submissionStatusLine(row.status, row.message, row.kind || "payroll"),
    totals: row.totals || null,
    message: row.message,
    attempts: Number(row.attempts || 0),
    queuedBy: row.queued_by,
    queuedAt: toIsoTimestamp(row.queued_at),
    startedAt: toIsoTimestamp(row.started_at),
    finishedAt: toIsoTimestamp(row.finished_at),
  };
}

/** What the payroll page needs for approval: blockers, the week's missed clock-outs, and submission status lines. */
export async function payrollApprovalOverview(business: Business, weekStart: string) {
  await ensurePayrollApprovalSchema();
  const [blockers, clockOutCases, submissions] = await Promise.all([
    payrollApprovalBlockers(business, weekStart),
    missedClockOutCasesForBusiness(business, { weekStart }),
    getSql()`
      SELECT s.*, r.version FROM payroll_submissions s
      JOIN payroll_run_versions r ON r.id = s.payroll_run_version_id
      WHERE s.business = ${business} AND s.kind = 'payroll'
      ORDER BY s.queued_at DESC LIMIT 50
    ` as unknown as Promise<SubmissionRow[]>,
  ]);
  return {
    blockers,
    clockOutCases,
    submissions: submissions.map(mapSubmission),
    sendsToPayrollRelief: business === PAYROLL_RELIEF_BUSINESS,
    payrollRelief: business === PAYROLL_RELIEF_BUSINESS ? await payrollReliefOverview(business) : null,
  };
}

// ---------------------------------------------------------------------------
// Store-server job (cron endpoints)

type SubmissionPayload = {
  id: string | null;
  kind: "payroll" | "roster";
  preview: boolean;
  status: string;
  business: Business;
  weekStart: string | null;
  weekEnd: string | null;
  payrollRunVersionId: string | null;
  version: number;
  runStatus: string | null;
  lockedBy: string;
  lockedAt: string | null;
  rows: unknown[];
  /** Corner Ops payroll name → Payroll Relief EE #, as confirmed on the payroll page. */
  mapping: Array<{ employee: string; key: string; eeNum: string }>;
  csvFileName: string | null;
  csv: string | null;
};

async function payrollReliefMapping(business: Business) {
  const rows = await getSql()`
    SELECT employee_key, employee_name, ee_num FROM payroll_relief_employees WHERE business = ${business} ORDER BY employee_name
  ` as unknown as Array<{ employee_key: string; employee_name: string; ee_num: string }>;
  return rows.map((row) => ({ employee: row.employee_name, key: row.employee_key, eeNum: String(row.ee_num) }));
}

async function runPayload(input: {
  id: string | null; kind: "payroll" | "roster"; preview: boolean; status: string; business: Business; runId: string | null;
}): Promise<SubmissionPayload> {
  const sql = getSql();
  const runs = input.runId ? await sql`
    SELECT week_start::text AS week_start, version, status, week_end, payload, locked_by, locked_at FROM payroll_run_versions WHERE id = ${input.runId} LIMIT 1
  ` as unknown as Array<{ week_start: string; version: number; status: string; week_end: string; payload: { rows?: unknown[] }; locked_by: string | null; locked_at: string | null }> : [];
  const run = runs[0];
  const csv = input.runId && run ? await payrollCsv(input.runId) : null;
  return {
    id: input.id,
    kind: input.kind,
    preview: input.preview,
    status: input.status,
    business: input.business,
    weekStart: run ? weekText(run.week_start) : null,
    weekEnd: run ? toIsoTimestamp(run.week_end) : null,
    payrollRunVersionId: input.runId,
    version: Number(run?.version || 0),
    runStatus: run?.status ?? null,
    lockedBy: run?.locked_by || "",
    lockedAt: run ? toIsoTimestamp(run.locked_at) : null,
    rows: run?.payload?.rows || [],
    mapping: await payrollReliefMapping(input.business),
    csvFileName: csv?.fileName ?? null,
    csv: csv?.csv ?? null,
  };
}

/** A run that never reports back fails after 75 minutes (20 waiting for the lock, 10 for a code, then the run), also one stuck waiting for a code. The Docks is never handed out. */
async function expireStaleSubmissions() {
  const sql = getSql();
  await sql`
    UPDATE payroll_submissions SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
      message = 'The Payroll Relief job stopped before reporting back. Check the entries in Payroll Relief, then send it again from payroll.'
    WHERE status IN ('submitting', 'needs_code') AND started_at < NOW() - INTERVAL '75 minutes'
  `;
  await sql`
    UPDATE payroll_submissions SET status = 'cancelled', finished_at = NOW(), updated_at = NOW(), message = ${DOCKS_NOT_SENT}
    WHERE status = 'queued' AND business <> ${PAYROLL_RELIEF_BUSINESS}
  `;
}

/** Hands queued submissions (and Check AccountantsOffice requests) to the job, marked "submitting", with the locked payroll to enter. */
export async function takePayrollSubmissions(limit = 3) {
  await ensurePayrollApprovalSchema();
  await expireStaleSubmissions();
  const rows = await getSql()`
    UPDATE payroll_submissions SET status = 'submitting', started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
    WHERE id IN (
      SELECT s.id FROM payroll_submissions s
      LEFT JOIN payroll_run_versions r ON r.id = s.payroll_run_version_id
      WHERE s.status = 'queued' AND s.business = ${PAYROLL_RELIEF_BUSINESS}
        AND (s.kind = 'roster' OR r.status = 'Locked')
      ORDER BY s.queued_at LIMIT ${Math.max(1, Math.min(10, limit))}
      FOR UPDATE OF s SKIP LOCKED
    )
    RETURNING id, kind, business, payroll_run_version_id
  ` as unknown as Array<{ id: string; kind: "payroll" | "roster"; business: Business; payroll_run_version_id: string | null }>;
  const submissions = [];
  for (const row of rows) {
    submissions.push(await runPayload({
      id: String(row.id), kind: row.kind, preview: false, status: "submitting", business: row.business,
      runId: row.payroll_run_version_id ? String(row.payroll_run_version_id) : null,
    }));
  }
  return submissions;
}

/** One submission's details for the job, by id. Changes nothing. */
export async function payrollSubmissionDetails(id: string): Promise<SubmissionPayload | null> {
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    SELECT id, kind, status, business, payroll_run_version_id FROM payroll_submissions WHERE id::text = ${id} LIMIT 1
  ` as unknown as Array<{ id: string; kind: "payroll" | "roster"; status: string; business: Business; payroll_run_version_id: string | null }>;
  const row = rows[0];
  if (!row) return null;
  return runPayload({
    id: String(row.id), kind: row.kind, preview: false, status: row.status, business: row.business,
    runId: row.payroll_run_version_id ? String(row.payroll_run_version_id) : null,
  });
}

/**
 * For a dry run without a queued submission: the same payload from the latest payroll version of a week
 * (draft or locked). Changes nothing; the job never reports a preview to the queue.
 */
export async function payrollSubmissionPreview(business: Business, weekStart: string): Promise<SubmissionPayload | null> {
  await ensurePayrollApprovalSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new ValidationError("weekStart must be a Monday as YYYY-MM-DD.");
  const runs = await getSql()`
    SELECT id FROM payroll_run_versions WHERE business = ${business} AND week_start = ${weekStart}::date ORDER BY version DESC LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!runs[0]) return null;
  return runPayload({ id: null, kind: "payroll", preview: true, status: "preview", business, runId: String(runs[0].id) });
}

/** The code the owner typed for a submission waiting on AccountantsOffice's texted code (handed out once, within 15 minutes). */
export async function takePayrollSubmissionCode(id: string): Promise<string | null> {
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    UPDATE payroll_submissions s SET code = NULL, status = 'submitting', message = 'Signing in with the code you entered…', updated_at = NOW()
    FROM (SELECT id, code FROM payroll_submissions WHERE id::text = ${id} AND status = 'needs_code' AND code IS NOT NULL
      AND code_at > NOW() - INTERVAL '15 minutes' FOR UPDATE) old
    WHERE s.id = old.id
    RETURNING old.code
  ` as unknown as Array<{ code: string }>;
  return rows[0] ? String(rows[0].code) : null;
}

/** The owner types the code AccountantsOffice texted them. */
export async function enterPayrollSubmissionCode(input: { id: string; business: Business; code: string; actor: string }) {
  await ensurePayrollApprovalSchema();
  const code = String(input.code || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9]{4,10}$/.test(code)) throw new ValidationError("Enter the code from the text (4 to 10 letters or numbers).");
  const rows = await getSql()`
    UPDATE payroll_submissions SET code = ${code}, code_at = NOW(), message = 'Code entered; the store server will use it within a few seconds.', updated_at = NOW()
    WHERE id::text = ${input.id} AND business = ${input.business} AND status = 'needs_code'
    RETURNING id, payroll_run_version_id
  ` as unknown as Array<{ id: string; payroll_run_version_id: string | null }>;
  if (!rows[0]) throw new ValidationError("That sign-in is no longer waiting for a code. If it failed, press Send again.");
  await audit(input.business, "AccountantsOffice Code Entered", String(rows[0].payroll_run_version_id || rows[0].id), { submissionId: input.id }, input.actor);
  return { entered: true };
}

/** "Check AccountantsOffice": the job signs in, downloads the timesheet, and reports Payroll Relief's employees. */
export async function requestPayrollReliefRosterCheck(input: { business: Business; actor: string }) {
  if (input.business !== PAYROLL_RELIEF_BUSINESS) throw new ValidationError(DOCKS_NOT_SENT);
  await ensurePayrollApprovalSchema();
  const pending = await getSql()`
    SELECT id FROM payroll_submissions WHERE business = ${input.business} AND kind = 'roster' AND status IN ('queued', 'submitting', 'needs_code') LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (pending[0]) return { id: String(pending[0].id), queued: false };
  const id = crypto.randomUUID();
  await getSql()`INSERT INTO payroll_submissions (id, kind, business, queued_by) VALUES (${id}, 'roster', ${input.business}, ${input.actor})`;
  return { id, queued: true };
}

/** The job reports the employees in Payroll Relief's timesheet download. */
export async function recordPayrollReliefRoster(business: Business, entries: RosterEntry[]) {
  await ensurePayrollApprovalSchema();
  let saved = 0;
  for (const entry of entries.slice(0, 500)) {
    const num = String(entry.num || "").trim().slice(0, 40);
    const name = String(entry.name || "").trim().slice(0, 200);
    if (!num || !name) continue;
    await getSql()`
      INSERT INTO payroll_relief_roster (business, ee_num, name, pay_type, last_seen_at)
      VALUES (${business}, ${num}, ${name}, ${String(entry.payType || "").trim().slice(0, 4).toUpperCase()}, NOW())
      ON CONFLICT (business, ee_num) DO UPDATE SET name = EXCLUDED.name, pay_type = EXCLUDED.pay_type, last_seen_at = NOW()
    `;
    saved++;
  }
  return { saved };
}

/** The owner confirms which Payroll Relief employee each Corner Ops name is ("" = none). */
export async function savePayrollReliefMappings(input: { business: Business; mappings: Array<{ employee: string; eeNum: string }>; actor: string }) {
  if (input.business !== PAYROLL_RELIEF_BUSINESS) throw new ValidationError(DOCKS_NOT_SENT);
  await ensurePayrollApprovalSchema();
  const roster = new Set((await getSql()`SELECT ee_num FROM payroll_relief_roster WHERE business = ${input.business}` as unknown as Array<{ ee_num: string }>).map((r) => String(r.ee_num)));
  const changes: Array<{ employee: string; eeNum: string }> = [];
  const used = new Map<string, string>();
  for (const item of input.mappings.slice(0, 300)) {
    const employee = String(item.employee || "").trim().slice(0, 120);
    const eeNum = String(item.eeNum || "").trim().slice(0, 40);
    if (!employee) continue;
    if (eeNum && !roster.has(eeNum)) throw new ValidationError(`EE #${eeNum} isn't in Payroll Relief's employee list.`);
    if (eeNum && used.has(eeNum)) throw new ValidationError(`${used.get(eeNum)} and ${employee} are both set to EE #${eeNum}. Choose one person for each Payroll Relief employee.`);
    if (eeNum) used.set(eeNum, employee);
    changes.push({ employee, eeNum });
  }
  for (const { employee, eeNum } of changes) {
    if (!eeNum) {
      await getSql()`DELETE FROM payroll_relief_employees WHERE business = ${input.business} AND employee_key = ${employeeKey(employee)}`;
      continue;
    }
    await getSql()`
      INSERT INTO payroll_relief_employees (business, employee_key, employee_name, ee_num, confirmed_by, confirmed_at)
      VALUES (${input.business}, ${employeeKey(employee)}, ${employee}, ${eeNum}, ${input.actor}, NOW())
      ON CONFLICT (business, employee_key) DO UPDATE SET employee_name = EXCLUDED.employee_name, ee_num = EXCLUDED.ee_num,
        confirmed_by = EXCLUDED.confirmed_by, confirmed_at = NOW()
    `;
  }
  await audit(input.business, "Payroll Relief Employees Matched", "payroll-relief-employees", { changes }, input.actor);
  return { saved: changes.length };
}

/**
 * The "AccountantsOffice employees" section: everyone in recent Corner Deli payrolls plus active employees,
 * each with the saved EE # or a best guess for the owner to confirm, and Payroll Relief's employee list.
 */
export async function payrollReliefOverview(business: Business) {
  await ensurePayrollApprovalSchema();
  const sql = getSql();
  const [rosterRows, mapping, payrollNames, activeNames, checks] = await Promise.all([
    sql`SELECT ee_num, name, pay_type, last_seen_at FROM payroll_relief_roster WHERE business = ${business} ORDER BY name` as unknown as Promise<Array<{ ee_num: string; name: string; pay_type: string; last_seen_at: string }>>,
    payrollReliefMapping(business),
    sql`
      SELECT DISTINCT BTRIM(item->>'employee') AS name
      FROM payroll_run_versions r, jsonb_array_elements(COALESCE(r.payload->'rows', '[]'::jsonb)) item
      WHERE r.business = ${business} AND r.week_start >= (CURRENT_DATE - INTERVAL '84 days')
    ` as unknown as Promise<Array<{ name: string }>>,
    sql`SELECT name FROM employees WHERE business = ${business} AND active = TRUE AND role_group <> 'Ignore'` as unknown as Promise<Array<{ name: string }>>,
    sql`SELECT * FROM payroll_submissions WHERE business = ${business} AND kind = 'roster' ORDER BY queued_at DESC LIMIT 1` as unknown as Promise<SubmissionRow[]>,
  ]);
  const roster = rosterRows.map((row) => ({ num: String(row.ee_num), name: row.name, payType: row.pay_type, display: rosterDisplayName(row.name), lastSeenAt: toIsoTimestamp(row.last_seen_at) }));
  const people = new Map<string, { employee: string; inPayroll: boolean; active: boolean }>();
  const add = (name: string, flag: "inPayroll" | "active") => {
    const clean = String(name || "").trim();
    if (!clean || /^(unallocated|cover)$/i.test(clean)) return;
    const key = employeeKey(clean);
    const entry = people.get(key) || { employee: clean, inPayroll: false, active: false };
    entry[flag] = true;
    people.set(key, entry);
  };
  payrollNames.forEach((row) => add(row.name, "inPayroll"));
  activeNames.forEach((row) => add(row.name, "active"));
  for (const saved of mapping) if (!people.has(saved.key)) people.set(saved.key, { employee: saved.employee, inPayroll: false, active: false });
  const savedByKey = new Map(mapping.map((m) => [m.key, m.eeNum]));
  const unsaved = [...people.entries()].filter(([key]) => !savedByKey.has(key)).map(([, p]) => p.employee);
  const guesses = guessRosterMatches(unsaved, roster, mapping.map((m) => m.eeNum));
  const list = [...people.entries()].map(([key, p]) => {
    const saved = savedByKey.get(key) || null;
    const guess = saved ? null : guesses[p.employee] || null;
    return { ...p, eeNum: saved, guessNum: guess?.num || null, guessReason: guess?.reason || "" };
  }).sort((a, b) => Number(b.inPayroll) - Number(a.inPayroll) || a.employee.localeCompare(b.employee));
  return { roster, people: list, rosterCheck: checks[0] ? mapSubmission(checks[0]) : null };
}

type ReportStatus = "submitted" | "failed" | "needs_code";

/**
 * The job reports how a submission went. needs_code: AccountantsOffice texted the owner a code (the owner is
 * emailed where to type it). submitted (= saved in Payroll Relief for the owner to review and Submit) or
 * failed: final, with one email to the owner. Roster checks are never emailed.
 */
export async function recordPayrollSubmissionResult(input: { id: string; status: ReportStatus; message?: string; totals?: HoursTotals | null }) {
  await ensurePayrollApprovalSchema();
  const message = String(input.message || "").trim().slice(0, 1000);
  const totals = input.totals && typeof input.totals === "object"
    ? { reg: Number(input.totals.reg || 0), tipHours: Number(input.totals.tipHours || 0), tips: Number(input.totals.tips || 0), ot: Number(input.totals.ot || 0) }
    : null;
  const sql = getSql();
  if (input.status === "needs_code") {
    const rows = await sql`
      UPDATE payroll_submissions SET status = 'needs_code', message = ${message}, code = NULL, updated_at = NOW()
      WHERE id::text = ${input.id} AND status = 'submitting'
      RETURNING id, kind, business, week_start, code_emailed_at
    ` as unknown as Array<{ id: string; kind: string; business: Business; week_start: string | Date | null; code_emailed_at: string | null }>;
    const row = rows[0];
    if (!row) return { recorded: false, reason: "No submission with that id is being sent." };
    let emailed = false;
    const recipients = payrollNotifyEmails();
    if (!row.code_emailed_at && recipients.length) {
      const weekStart = row.week_start ? weekText(row.week_start) : null;
      const email = payrollCodeEmail({ business: row.business, weekStart, link: payrollControlLink(row.business, weekStart || currentPayrollWeekStart()) });
      try {
        emailed = (await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text })).sent > 0;
      } catch (error) {
        console.error("[payroll-submission] code email failed", error);
      }
      if (emailed) await sql`UPDATE payroll_submissions SET code_emailed_at = NOW() WHERE id = ${row.id}`;
    }
    return { recorded: true, status: input.status, emailed };
  }

  const rows = await sql`
    UPDATE payroll_submissions SET status = ${input.status}, message = ${message}, totals = ${totals ? JSON.stringify(totals) : null}::jsonb,
      code = NULL, finished_at = NOW(), updated_at = NOW()
    WHERE id::text = ${input.id} AND status IN ('submitting', 'needs_code')
    RETURNING id, kind, business, week_start, payroll_run_version_id
  ` as unknown as Array<{ id: string; kind: "payroll" | "roster"; business: Business; week_start: string | Date | null; payroll_run_version_id: string | null }>;
  const row = rows[0];
  if (!row) return { recorded: false, reason: "No submission with that id is being sent." };
  if (row.kind === "roster" || !row.week_start || !row.payroll_run_version_id) return { recorded: true, status: input.status, emailed: false };
  const weekStart = weekText(row.week_start);
  await audit(row.business, input.status === "submitted" ? "Payroll Saved in Payroll Relief" : "Payroll Relief Entry Failed", String(row.payroll_run_version_id),
    { submissionId: String(row.id), weekStart, message, totals, destination: "Payroll Relief (saved, not submitted)" }, "Payroll Relief job");

  let emailed = false;
  const claimed = await sql`
    UPDATE payroll_submissions SET confirmation_emailed_at = NOW() WHERE id = ${row.id} AND confirmation_emailed_at IS NULL RETURNING id
  ` as unknown as Array<{ id: string }>;
  const recipients = payrollNotifyEmails();
  if (claimed[0] && recipients.length) {
    const versions = await sql`SELECT version FROM payroll_run_versions WHERE id = ${row.payroll_run_version_id} LIMIT 1` as unknown as Array<{ version: number }>;
    const email = payrollSubmissionEmail({
      business: row.business, weekStart, version: Number(versions[0]?.version || 0), status: input.status, message,
      link: payrollControlLink(row.business, weekStart), totalsText: totals ? formatTotals(totals) : undefined,
    });
    try {
      emailed = (await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text })).sent > 0;
    } catch (error) {
      console.error("[payroll-submission] confirmation email failed", error);
    }
    if (!emailed) await sql`UPDATE payroll_submissions SET confirmation_emailed_at = NULL WHERE id = ${row.id}`;
  }
  return { recorded: true, status: input.status, emailed };
}

// ---------------------------------------------------------------------------
// Monday scheduler step

/**
 * Drafts last week's payroll (unless a version already exists) and emails the
 * owner the totals, anything blocking approval, and a "Review and approve"
 * link. Sends at most once per business and week.
 */
const APPROVAL_GRACE_MS = 30 * 60_000;

/**
 * Called every 15 minutes (with the missed clock-out check): once last week has
 * ended, drafts it and sends the Monday approval email (once per business per
 * week). Only in the two days after the week ends, so a new install doesn't
 * email about an old week later in the week.
 */
export async function catchUpPayrollApprovals(now = new Date()) {
  const weekStart = addDateKeyDays(currentPayrollWeekStart(now), -7);
  const end = payrollWeekBounds(weekStart).end.getTime();
  if (now.getTime() < end + APPROVAL_GRACE_MS || now.getTime() > end + 2 * 24 * 60 * 60_000) return { weekStart, skipped: true };
  const results: Record<string, unknown> = {};
  for (const business of ["Corner Deli", "Tiki"] as const) results[business] = await preparePayrollApproval(business, weekStart);
  return { weekStart, results };
}

export async function preparePayrollApproval(business: Business, weekStart: string, actor = "Nightly scheduler") {
  // The payroll week ends Monday 4 AM; drafting earlier (the 3 AM scheduler run in summer) would leave out late punches.
  if (Date.now() < payrollWeekBounds(weekStart).end.getTime() + APPROVAL_GRACE_MS) return { skipped: true, reason: "The payroll week hasn't ended yet." };
  await ensurePayrollApprovalSchema();
  const versions = await getSql()`
    SELECT id, version, status, payload FROM payroll_run_versions
    WHERE business = ${business} AND week_start = ${weekStart}::date
    ORDER BY version DESC LIMIT 1
  ` as unknown as Array<{ id: string; version: number; status: string; payload: { rows?: WorkedRowInput[]; processingFeeReviewCount?: number; scheduleComparison?: ScheduleComparison[] } }>;
  const latest = versions[0];
  if (latest?.status === "Locked") return { skipped: true, reason: "Payroll for this week is already approved.", version: Number(latest.version) };

  let draft: { version: number; created: boolean } | { error: string };
  let rows: WorkedRowInput[] = [];
  let comparison: ScheduleComparison[] | undefined;
  let missingSquareFees = 0;
  if (latest) {
    draft = { version: Number(latest.version), created: false };
    rows = latest.payload?.rows || [];
    comparison = latest.payload?.scheduleComparison;
    missingSquareFees = Number(latest.payload?.processingFeeReviewCount || 0);
  } else {
    try {
      const created = await createPayrollDraft({ business, weekStart, actor });
      draft = { version: Number(created.version), created: true };
      rows = created.summary.rows || [];
      comparison = created.summary.scheduleComparison;
      missingSquareFees = Number(created.summary.processingFeeReviewCount || 0);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      draft = { error: error.message };
      const summary = await controlledPayrollSummary(business, weekStart);
      rows = summary.rows || [];
      comparison = summary.scheduleComparison;
      missingSquareFees = Number(summary.processingFeeReviewCount || 0);
    }
  }
  const blockers = await clockOutBlockersForWeek(business, weekStart);
  const recipients = payrollNotifyEmails();
  if (!recipients.length) return { draft, blockers, emailed: false, reason: "PAYROLL_NOTIFY_EMAIL / APP_EMAIL is not set." };

  const claimed = await getSql()`
    INSERT INTO payroll_week_notices (business, week_start, kind, details)
    VALUES (${business}, ${weekStart}::date, 'approval_request', ${JSON.stringify({ draft, blockers })}::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING kind
  ` as unknown as Array<{ kind: string }>;
  if (!claimed[0]) return { draft, blockers, emailed: false, reason: "The approval email for this week was already sent." };

  const displayRows = payrollDisplayRows(rows, comparison || await scheduleComparisonFor(business, weekStart, rows as Parameters<typeof scheduleComparisonFor>[2]))
    .map((row) => ({ ...row, schedule: row.schedule ? { text: row.schedule.text, flagged: row.schedule.flagged } : null }));
  const email = payrollApprovalEmail({
    business, weekStart, rows: displayRows, draft, blockers, missingSquareFees, needsReview: blockers.needsReview,
    reviewLink: payrollControlLink(business, weekStart),
  });
  let sent = 0;
  let configured = true;
  let failure = "";
  try {
    const delivery = await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text, idempotencyKey: `payroll-approval-${business}-${weekStart}`.replace(/\s+/g, "-") });
    sent = delivery.sent;
    configured = delivery.configured;
    failure = delivery.failures.join("; ");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (!sent) {
    // Release the claim so a later scheduler attempt can send it.
    await getSql()`DELETE FROM payroll_week_notices WHERE business = ${business} AND week_start = ${weekStart}::date AND kind = 'approval_request'`;
    if (!configured) return { draft, blockers, emailed: false, reason: "Outbound email is not configured." };
    throw new Error(`Payroll approval email was not sent: ${failure || "no recipient accepted it"}`);
  }
  return { draft, blockers, emailed: true };
}

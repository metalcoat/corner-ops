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
import { currentPayrollWeekStart } from "@/lib/payroll-week";
import {
  AUTO_APPROVAL_ACTOR,
  autoSendDecision,
  autoSendSkippedEmail,
  blockerReasons,
  mondayJobWeek,
  payrollMondaySchedule,
  payrollMondaySummaryEmail,
  payrollSummaryFingerprint,
  summaryDecision,
  summaryWasLate,
  type SummaryScheduleRow,
} from "@/lib/payroll-auto-rules";

/**
 * Monday payroll approval and the AccountantsOffice (Payroll Relief) queue.
 * 8:00 AM Monday: a freshly recalculated summary email (waits for Sunday's punches until noon).
 * 5:00 PM Monday: automatic approval unless the week is on Hold (payroll_week_holds) or blocked.
 * Approving is the existing lock (lockPayrollRun), refused while the week has
 * open punches or unresolved missed clock-outs. Each Corner Deli lock queues one
 * submission; the store server's job (deploy/supplier-scraper/payroll-relief.mjs)
 * takes queued ones from /api/cron/payroll-submissions, enters the hours and tips
 * in Payroll Relief and SAVES them, and reports the outcome ("submitted" = saved
 * for the owner to review and Submit). Only when the store server has
 * PAYROLL_RELIEF_AUTO_SUBMIT=1 and the submission has submit_after_save does the
 * job then press Submit, once (submit_pressed_at is recorded here first), and
 * report "sent" when Payroll Relief confirms it. The Docks (Tiki, a separate
 * company) is never sent.
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
      if (!checks[0] || !checks[0].def.includes("'sent'")) {
        await sql`ALTER TABLE payroll_submissions DROP CONSTRAINT IF EXISTS payroll_submissions_status_check`;
        await sql`
          ALTER TABLE payroll_submissions ADD CONSTRAINT payroll_submissions_status_check
          CHECK (status IN ('queued', 'submitting', 'needs_code', 'submitted', 'sent', 'failed', 'cancelled'))
        `;
      }
      // Press Submit after saving (only where the store server allows it), and when the job pressed it (never twice).
      await sql`ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS submit_after_save BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS submit_pressed_at TIMESTAMPTZ`;
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
      // Hold: keeps a week from being approved automatically at 5 PM Monday (released_at NULL = on hold).
      await sql`
        CREATE TABLE IF NOT EXISTS payroll_week_holds (
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          week_start DATE NOT NULL,
          held_by TEXT NOT NULL,
          held_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          released_by TEXT,
          released_at TIMESTAMPTZ,
          PRIMARY KEY (business, week_start)
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

/**
 * Approve = lock, refused with a clear message while the week still has open punches or missed clock-outs.
 * The Corner Deli submission it queues may press Submit after saving (submit_after_save), which the store
 * server only does with PAYROLL_RELIEF_AUTO_SUBMIT=1. unlessHeld: the automatic approval, refused on Hold.
 */
export async function approvePayrollRun(input: { id: string; business: Business; actor: string; unlessHeld?: boolean }) {
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
  const locked = await lockPayrollRun(input.id, input.actor, { unlessHeld: input.unlessHeld });
  // The Docks is a separate company (and closed for the season): it is never entered automatically.
  if (input.business !== PAYROLL_RELIEF_BUSINESS) return { ...locked, submission: null, submissionNote: DOCKS_NOT_SENT };
  const submission = await queuePayrollSubmission({ runId: input.id, business: input.business, weekStart, actor: input.actor, submitAfterSave: true });
  return { ...locked, submission };
}

export async function queuePayrollSubmission(input: { runId: string; business: Business; weekStart: string; actor: string; submitAfterSave?: boolean }) {
  if (input.business !== PAYROLL_RELIEF_BUSINESS) return null;
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    INSERT INTO payroll_submissions (id, business, week_start, payroll_run_version_id, queued_by, submit_after_save)
    VALUES (${crypto.randomUUID()}, ${input.business}, ${input.weekStart}::date, ${input.runId}, ${input.actor}, ${Boolean(input.submitAfterSave)})
    ON CONFLICT (payroll_run_version_id) DO NOTHING
    RETURNING id, status
  ` as unknown as Array<{ id: string; status: string }>;
  if (rows[0]) await audit(input.business, "Payroll Submission Queued", input.runId, { weekStart: input.weekStart, submissionId: rows[0].id, destination: "AccountantsOffice", submitAfterSave: Boolean(input.submitAfterSave) }, input.actor);
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
      AND s.submit_pressed_at IS NULL
      AND r.id = s.payroll_run_version_id AND r.status = 'Locked'
    RETURNING s.id, s.payroll_run_version_id
  ` as unknown as Array<{ id: string; payroll_run_version_id: string }>;
  if (!rows[0]) {
    const pressed = await getSql()`SELECT 1 AS pressed FROM payroll_submissions WHERE id::text = ${input.id} AND submit_pressed_at IS NOT NULL` as unknown as Array<{ pressed: number }>;
    if (pressed[0]) throw new ValidationError("Submit was already pressed in Payroll Relief for this payroll, so it can't be sent again. Check Payroll Relief first.");
    throw new ValidationError("Only a failed (or already saved) submission of a locked payroll can be sent again.");
  }
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
  submit_after_save?: boolean | null;
  submit_pressed_at?: string | null;
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
    submitAfterSave: Boolean(row.submit_after_save),
    submitPressedAt: toIsoTimestamp(row.submit_pressed_at ?? null),
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
    autoSend: await payrollAutoSendStatus(business, weekStart),
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
  /** Press Submit after a verified save — only if the store server also has PAYROLL_RELIEF_AUTO_SUBMIT=1. */
  submitAfterSave: boolean;
  /** Submit was already pressed for this submission: never press it again. */
  submitPressedAt: string | null;
};

async function payrollReliefMapping(business: Business) {
  const rows = await getSql()`
    SELECT employee_key, employee_name, ee_num FROM payroll_relief_employees WHERE business = ${business} ORDER BY employee_name
  ` as unknown as Array<{ employee_key: string; employee_name: string; ee_num: string }>;
  return rows.map((row) => ({ employee: row.employee_name, key: row.employee_key, eeNum: String(row.ee_num) }));
}

async function runPayload(input: {
  id: string | null; kind: "payroll" | "roster"; preview: boolean; status: string; business: Business; runId: string | null;
  submitAfterSave?: boolean; submitPressedAt?: string | null;
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
    submitAfterSave: input.kind === "payroll" && !input.preview && Boolean(input.submitAfterSave),
    submitPressedAt: toIsoTimestamp(input.submitPressedAt ?? null),
  };
}

/** A run that never reports back fails after 75 minutes (20 waiting for the lock, 10 for a code, then the run), also one stuck waiting for a code. The Docks is never handed out. */
async function expireStaleSubmissions() {
  const sql = getSql();
  await sql`
    UPDATE payroll_submissions SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
      message = CASE WHEN submit_pressed_at IS NOT NULL
        THEN 'Pressed Submit but couldn''t confirm — check Payroll Relief (the job stopped before reporting back).'
        ELSE 'The Payroll Relief job stopped before reporting back. Check the entries in Payroll Relief, then send it again from payroll.' END
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
    RETURNING id, kind, business, payroll_run_version_id, submit_after_save, submit_pressed_at
  ` as unknown as Array<{ id: string; kind: "payroll" | "roster"; business: Business; payroll_run_version_id: string | null; submit_after_save: boolean; submit_pressed_at: string | null }>;
  const submissions = [];
  for (const row of rows) {
    submissions.push(await runPayload({
      id: String(row.id), kind: row.kind, preview: false, status: "submitting", business: row.business,
      runId: row.payroll_run_version_id ? String(row.payroll_run_version_id) : null,
      submitAfterSave: Boolean(row.submit_after_save), submitPressedAt: row.submit_pressed_at,
    }));
  }
  return submissions;
}

/** One submission's details for the job, by id. Changes nothing. */
export async function payrollSubmissionDetails(id: string): Promise<SubmissionPayload | null> {
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    SELECT id, kind, status, business, payroll_run_version_id, submit_after_save, submit_pressed_at FROM payroll_submissions WHERE id::text = ${id} LIMIT 1
  ` as unknown as Array<{ id: string; kind: "payroll" | "roster"; status: string; business: Business; payroll_run_version_id: string | null; submit_after_save: boolean; submit_pressed_at: string | null }>;
  const row = rows[0];
  if (!row) return null;
  return runPayload({
    id: String(row.id), kind: row.kind, preview: false, status: row.status, business: row.business,
    runId: row.payroll_run_version_id ? String(row.payroll_run_version_id) : null,
    submitAfterSave: Boolean(row.submit_after_save), submitPressedAt: row.submit_pressed_at,
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

type ReportStatus = "submitted" | "sent" | "failed" | "needs_code";

/**
 * The job is about to press Submit in Payroll Relief: recorded BEFORE the click, once. Granted only for a
 * payroll submission being sent, marked submit_after_save, and never pressed before; the job presses
 * Submit only when this returns granted.
 */
export async function claimPayrollSubmitPress(id: string): Promise<{ granted: boolean; reason?: string }> {
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    UPDATE payroll_submissions SET submit_pressed_at = NOW(), message = 'Pressing Submit in Payroll Relief…', updated_at = NOW()
    WHERE id::text = ${id} AND kind = 'payroll' AND business = ${PAYROLL_RELIEF_BUSINESS}
      AND status = 'submitting' AND submit_after_save AND submit_pressed_at IS NULL
    RETURNING id, business, payroll_run_version_id, week_start
  ` as unknown as Array<{ id: string; business: Business; payroll_run_version_id: string; week_start: string | Date }>;
  if (!rows[0]) return { granted: false, reason: "This submission isn't set to be submitted, isn't being sent, or Submit was already pressed." };
  await audit(rows[0].business, "Payroll Relief Submit Pressed", String(rows[0].payroll_run_version_id),
    { submissionId: String(rows[0].id), weekStart: weekText(rows[0].week_start), destination: "Payroll Relief (Submit)" }, "Payroll Relief job");
  return { granted: true };
}

/**
 * The job reports how a submission went. needs_code: AccountantsOffice texted the owner a code (the owner is
 * emailed where to type it). submitted (= saved in Payroll Relief for the owner to review and Submit),
 * sent (= Submit pressed and confirmed) or failed: final, with one email to the owner, each worded
 * differently. Roster checks are never emailed.
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

  // "sent" (submitted to the accountants) is only accepted after the job recorded pressing Submit.
  const rows = await sql`
    UPDATE payroll_submissions SET status = ${input.status}, message = ${message}, totals = ${totals ? JSON.stringify(totals) : null}::jsonb,
      code = NULL, finished_at = NOW(), updated_at = NOW()
    WHERE id::text = ${input.id} AND status IN ('submitting', 'needs_code')
      AND (${input.status}::text <> 'sent' OR submit_pressed_at IS NOT NULL)
    RETURNING id, kind, business, week_start, payroll_run_version_id, submit_pressed_at
  ` as unknown as Array<{ id: string; kind: "payroll" | "roster"; business: Business; week_start: string | Date | null; payroll_run_version_id: string | null; submit_pressed_at: string | null }>;
  const row = rows[0];
  if (!row) return { recorded: false, reason: "No submission with that id is being sent (or Submit wasn't recorded as pressed)." };
  if (row.kind === "roster" || !row.week_start || !row.payroll_run_version_id) return { recorded: true, status: input.status, emailed: false };
  const weekStart = weekText(row.week_start);
  const submitPressed = Boolean(row.submit_pressed_at);
  await audit(row.business,
    input.status === "sent" ? "Payroll Submitted in Payroll Relief" : input.status === "submitted" ? "Payroll Saved in Payroll Relief" : submitPressed ? "Payroll Relief Submit Unconfirmed" : "Payroll Relief Entry Failed",
    String(row.payroll_run_version_id),
    { submissionId: String(row.id), weekStart, message, totals, destination: input.status === "sent" ? "Payroll Relief (submitted)" : "Payroll Relief (saved, not submitted)", submitPressed }, "Payroll Relief job");

  let emailed = false;
  const claimed = await sql`
    UPDATE payroll_submissions SET confirmation_emailed_at = NOW() WHERE id = ${row.id} AND confirmation_emailed_at IS NULL RETURNING id
  ` as unknown as Array<{ id: string }>;
  const recipients = payrollNotifyEmails();
  if (claimed[0] && recipients.length) {
    const versions = await sql`SELECT version FROM payroll_run_versions WHERE id = ${row.payroll_run_version_id} LIMIT 1` as unknown as Array<{ version: number }>;
    const email = payrollSubmissionEmail({
      business: row.business, weekStart, version: Number(versions[0]?.version || 0), status: input.status, message,
      link: payrollControlLink(row.business, weekStart), totalsText: totals ? formatTotals(totals) : undefined, submitPressed,
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
// Hold (per business and week)

type HoldRow = { held_by: string; held_at: string; released_by: string | null; released_at: string | null };

async function activeHold(business: Business, weekStart: string) {
  const rows = await getSql()`
    SELECT held_by, held_at, released_by, released_at FROM payroll_week_holds WHERE business = ${business} AND week_start = ${weekStart}::date LIMIT 1
  ` as unknown as HoldRow[];
  const row = rows[0];
  return row && !row.released_at ? { heldBy: row.held_by, heldAt: toIsoTimestamp(row.held_at) } : null;
}

function checkWeek(weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new ValidationError("Choose a payroll week (its Monday, YYYY-MM-DD).");
}

/** Hold: the week is not approved automatically at 5 PM Monday. Manual approval still works. */
export async function holdPayrollWeek(input: { business: Business; weekStart: string; actor: string }) {
  checkWeek(input.weekStart);
  if (input.business !== PAYROLL_RELIEF_BUSINESS) throw new ValidationError(DOCKS_NOT_SENT);
  await ensurePayrollApprovalSchema();
  const latest = await latestRun(input.business, input.weekStart);
  if (latest?.status === "Locked") throw new ValidationError("This payroll is already approved. To stop it, reopen it as a new version.");
  await getSql()`
    INSERT INTO payroll_week_holds (business, week_start, held_by, held_at)
    VALUES (${input.business}, ${input.weekStart}::date, ${input.actor}, NOW())
    ON CONFLICT (business, week_start) DO UPDATE SET held_by = EXCLUDED.held_by, held_at = NOW(), released_by = NULL, released_at = NULL
  `;
  await audit(input.business, "Payroll Put On Hold", input.weekStart, { weekStart: input.weekStart }, input.actor);
  // The 5 PM approval may have just happened; say so rather than pretend the hold stopped it.
  const after = await latestRun(input.business, input.weekStart);
  return { held: true, alreadyApproved: after?.status === "Locked", hold: await activeHold(input.business, input.weekStart) };
}

export async function releasePayrollWeek(input: { business: Business; weekStart: string; actor: string }) {
  checkWeek(input.weekStart);
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    UPDATE payroll_week_holds SET released_by = ${input.actor}, released_at = NOW()
    WHERE business = ${input.business} AND week_start = ${input.weekStart}::date AND released_at IS NULL
    RETURNING held_by
  ` as unknown as Array<{ held_by: string }>;
  if (!rows[0]) throw new ValidationError("This payroll week isn't on hold.");
  await audit(input.business, "Payroll Hold Released", input.weekStart, { weekStart: input.weekStart, heldBy: rows[0].held_by }, input.actor);
  return { held: false };
}

/** For the payroll page: the 5 PM automatic send for this week, its hold, and what happened. */
export async function payrollAutoSendStatus(business: Business, weekStart: string, now = new Date()) {
  if (business !== PAYROLL_RELIEF_BUSINESS || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  await ensurePayrollApprovalSchema();
  const schedule = payrollMondaySchedule(weekStart);
  const [hold, notices, latest] = await Promise.all([
    activeHold(business, weekStart),
    weekNotices(business, weekStart),
    latestRun(business, weekStart),
  ]);
  const decided = notices.get("auto_send")?.details as { outcome?: string; reasons?: string[]; version?: number } | undefined;
  const summary = notices.get("approval_request")?.details as { sentAt?: string; sundayMissing?: boolean; late?: boolean } | undefined;
  return {
    sendAt: schedule.autoSendAt.toISOString(),
    windowEnd: schedule.windowEnd.toISOString(),
    pending: !decided?.outcome && latest?.status !== "Locked" && now.getTime() < schedule.windowEnd.getTime(),
    hold,
    outcome: decided?.outcome || null,
    reasons: decided?.reasons || [],
    summarySentAt: summary?.sentAt || null,
    summaryLate: Boolean(summary?.late),
    sundayMissing: Boolean(summary?.sundayMissing),
  };
}

// ---------------------------------------------------------------------------
// Monday: 8 AM summary, 5 PM automatic approval

type RunRow = { id: string; version: number; status: "Draft" | "Locked"; payload: Record<string, unknown> & { rows?: WorkedRowInput[]; scheduleComparison?: ScheduleComparison[]; processingFeeReviewCount?: number } };

async function latestRun(business: Business, weekStart: string): Promise<RunRow | null> {
  const rows = await getSql()`
    SELECT id, version, status, payload FROM payroll_run_versions
    WHERE business = ${business} AND week_start = ${weekStart}::date
    ORDER BY version DESC LIMIT 1
  ` as unknown as RunRow[];
  return rows[0] || null;
}

async function weekNotices(business: Business, weekStart: string) {
  const rows = await getSql()`
    SELECT kind, details, created_at FROM payroll_week_notices WHERE business = ${business} AND week_start = ${weekStart}::date
  ` as unknown as Array<{ kind: string; details: Record<string, unknown>; created_at: string }>;
  return new Map(rows.map((row) => [row.kind, row]));
}

async function claimNotice(business: Business, weekStart: string, kind: string, details: Record<string, unknown>) {
  const rows = await getSql()`
    INSERT INTO payroll_week_notices (business, week_start, kind, details)
    VALUES (${business}, ${weekStart}::date, ${kind}, ${JSON.stringify(details)}::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING kind
  ` as unknown as Array<{ kind: string }>;
  return Boolean(rows[0]);
}

async function setNotice(business: Business, weekStart: string, kind: string, details: Record<string, unknown>) {
  await getSql()`
    UPDATE payroll_week_notices SET details = ${JSON.stringify(details)}::jsonb
    WHERE business = ${business} AND week_start = ${weekStart}::date AND kind = ${kind}
  `;
}

async function releaseNotice(business: Business, weekStart: string, kind: string) {
  await getSql()`DELETE FROM payroll_week_notices WHERE business = ${business} AND week_start = ${weekStart}::date AND kind = ${kind}`;
}

/**
 * Recalculates the week and returns the draft to use: the latest draft when the recalculation is the same
 * (payrollSummaryFingerprint), else a new draft version. Null draft when it's already approved.
 */
export async function freshPayrollDraft(business: Business, weekStart: string, actor: string) {
  const latest = await latestRun(business, weekStart);
  if (latest?.status === "Locked") return { locked: true as const, version: Number(latest.version) };
  const summary = await controlledPayrollSummary(business, weekStart);
  if (latest && payrollSummaryFingerprint(latest.payload as Parameters<typeof payrollSummaryFingerprint>[0]) === payrollSummaryFingerprint(summary)) {
    return { locked: false as const, draft: { id: String(latest.id), version: Number(latest.version), created: false }, summary };
  }
  try {
    const created = await createPayrollDraft({ business, weekStart, actor });
    return { locked: false as const, draft: { id: String(created.id), version: Number(created.version), created: true }, summary: created.summary };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return { locked: false as const, draft: { error: error.message }, summary };
  }
}

/** Punches and published shifts on the week's Sunday (Sunday 4 AM → Monday 4 AM). */
async function sundayReadiness(business: Business, weekStart: string) {
  const s = payrollMondaySchedule(weekStart);
  const start = s.sundayStart.toISOString(), end = s.sundayEnd.toISOString();
  const shifts = await getSql()`
    SELECT COUNT(*)::INTEGER AS count FROM schedule_shifts
    WHERE business = ${business} AND status = 'Published' AND starts_at >= ${start} AND starts_at < ${end}
  ` as unknown as Array<{ count: number }>;
  const clock = await getSql()`
    SELECT COUNT(*)::INTEGER AS count FROM time_entries
    WHERE business = ${business} AND COALESCE(clock_in, clock_out) >= ${start} AND COALESCE(clock_in, clock_out) < ${end}
  ` as unknown as Array<{ count: number }>;
  let rezku = 0;
  if (business === "Corner Deli") {
    const rows = await getSql()`
      SELECT COUNT(*)::INTEGER AS count FROM rezku_shifts
      WHERE COALESCE(clock_in, clock_out) >= ${start} AND COALESCE(clock_in, clock_out) < ${end}
    ` as unknown as Array<{ count: number }>;
    rezku = Number(rows[0]?.count || 0);
  }
  return { sundayScheduledShifts: Number(shifts[0]?.count || 0), sundayPunches: Number(clock[0]?.count || 0) + rezku };
}

function summaryRows(summary: { rows?: WorkedRowInput[]; scheduleComparison?: ScheduleComparison[] }): SummaryScheduleRow[] {
  return payrollDisplayRows(summary.rows || [], summary.scheduleComparison || []).map((row) => ({
    ...row,
    schedule: row.schedule ? { text: row.schedule.text, flagged: row.schedule.flagged, missed: row.schedule.missed, untracked: row.schedule.untracked } : null,
  }));
}

/**
 * The Monday summary email, once per business and week, from 8:00 AM (waiting for Sunday's punches until
 * noon), with a freshly recalculated draft. Called every 15 minutes; does nothing outside its window.
 */
export async function sendMondaySummary(business: Business, weekStart: string, now = new Date()) {
  await ensurePayrollApprovalSchema();
  const notices = await weekNotices(business, weekStart);
  const latest = await latestRun(business, weekStart);
  const readiness = await sundayReadiness(business, weekStart);
  const decision = summaryDecision({ now, weekStart, ...readiness, alreadySent: notices.has("approval_request"), approved: latest?.status === "Locked" });
  if (decision.action !== "send") return { action: decision.action, ...readiness };
  const recipients = payrollNotifyEmails();
  if (!recipients.length) return { action: "send", emailed: false, reason: "PAYROLL_NOTIFY_EMAIL / APP_EMAIL is not set." };
  if (!(await claimNotice(business, weekStart, "approval_request", { claimedAt: now.toISOString() }))) return { action: "already_sent" };
  try {
    const fresh = await freshPayrollDraft(business, weekStart, "Monday 8 AM summary");
    if (fresh.locked) {
      await releaseNotice(business, weekStart, "approval_request");
      return { action: "already_approved" };
    }
    const blockers = await clockOutBlockersForWeek(business, weekStart);
    const late = summaryWasLate(weekStart, now);
    const email = payrollMondaySummaryEmail({
      business, weekStart, rows: summaryRows(fresh.summary), draft: fresh.draft, blockers: blockerReasons(blockers),
      missingSquareFees: Number(fresh.summary.processingFeeReviewCount || 0), needsReview: blockers.needsReview,
      clockOutsToCheck: blockers.clockOutsToCheck, sundayMissing: decision.sundayMissing,
      autoSend: business === PAYROLL_RELIEF_BUSINESS, late,
      reviewLink: payrollControlLink(business, weekStart),
      holdLink: `${payrollControlLink(business, weekStart)}&hold=1`,
    });
    const delivery = await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text, idempotencyKey: `payroll-summary-${business}-${weekStart}`.replace(/\s+/g, "-") });
    if (!delivery.sent) {
      await releaseNotice(business, weekStart, "approval_request");
      if (!delivery.configured) return { action: "send", emailed: false, reason: "Outbound email is not configured." };
      throw new Error(`Payroll summary email was not sent: ${delivery.failures.join("; ") || "no recipient accepted it"}`);
    }
    const draft = "error" in fresh.draft ? { error: fresh.draft.error } : { version: fresh.draft.version, created: fresh.draft.created };
    await setNotice(business, weekStart, "approval_request", { sentAt: now.toISOString(), draft, blockers, sundayMissing: decision.sundayMissing, late });
    return { action: "sent", emailed: true, draft, sundayMissing: decision.sundayMissing, late };
  } catch (error) {
    await releaseNotice(business, weekStart, "approval_request").catch(() => undefined);
    throw error;
  }
}

/** The scheduler's Monday step (3 AM) and older callers: the summary, which waits for its 8 AM window. */
export async function preparePayrollApproval(business: Business, weekStart: string) {
  return sendMondaySummary(business, weekStart);
}

/**
 * 5:00 PM Monday (window to Tuesday 11:59 PM), Corner Deli only, decided once per week: recalculate and
 * approve as "Automatic 5 PM approval" (which queues the AccountantsOffice submission), or, when on hold or
 * blocked, email once "Not sent at 5 PM: <reasons>".
 */
export async function autoApprovePayrollWeek(business: Business, weekStart: string, now = new Date()) {
  if (business !== PAYROLL_RELIEF_BUSINESS) return { action: "not_sent_automatically" };
  if (now.getTime() < payrollMondaySchedule(weekStart).autoSendAt.getTime()) return { action: "too_early" };
  await ensurePayrollApprovalSchema();
  const notices = await weekNotices(business, weekStart);
  const latest = await latestRun(business, weekStart);
  const lockedBefore = await getSql()`
    SELECT 1 AS present FROM payroll_run_versions
    WHERE business = ${business} AND week_start = ${weekStart}::date AND (locked_at IS NOT NULL OR reopened_from_id IS NOT NULL)
    LIMIT 1
  ` as unknown as Array<{ present: number }>;
  const hold = await activeHold(business, weekStart);
  const summaryDetails = notices.get("approval_request")?.details as { sentAt?: string } | undefined;
  const readiness = await sundayReadiness(business, weekStart);
  const blockers = await clockOutBlockersForWeek(business, weekStart);
  const decision = autoSendDecision({
    now, weekStart, latestStatus: latest?.status ?? null, everLocked: Boolean(lockedBefore[0]), heldBy: hold?.heldBy || null,
    summarySentAt: summaryDetails?.sentAt ? new Date(summaryDetails.sentAt) : null,
    sundayMissing: readiness.sundayScheduledShifts > 0 && readiness.sundayPunches === 0,
    blockers: blockerReasons(blockers), decided: notices.has("auto_send"),
  });
  if (decision.action !== "approve" && decision.action !== "not_sent") return { action: decision.action };
  if (!(await claimNotice(business, weekStart, "auto_send", { claimedAt: now.toISOString() }))) return { action: "already_decided" };

  let reasons = decision.reasons;
  if (decision.action === "approve") {
    try {
      const fresh = await freshPayrollDraft(business, weekStart, AUTO_APPROVAL_ACTOR);
      if (fresh.locked) {
        await setNotice(business, weekStart, "auto_send", { outcome: "already_approved", at: now.toISOString() });
        return { action: "already_approved" };
      }
      if ("error" in fresh.draft) throw new ValidationError(`the payroll draft couldn't be created: ${fresh.draft.error}`);
      const approved = await approvePayrollRun({ id: fresh.draft.id, business, actor: AUTO_APPROVAL_ACTOR, unlessHeld: true });
      await setNotice(business, weekStart, "auto_send", { outcome: "approved", at: now.toISOString(), version: fresh.draft.version, recalculated: fresh.draft.created, submissionId: approved.submission?.id || null });
      await audit(business, "Payroll Approved Automatically", fresh.draft.id, { weekStart, version: fresh.draft.version, recalculated: fresh.draft.created }, AUTO_APPROVAL_ACTOR);
      return { action: "approved", version: fresh.draft.version, submission: approved.submission };
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        await releaseNotice(business, weekStart, "auto_send");
        throw error;
      }
      reasons = [error.message];
    }
  }

  await setNotice(business, weekStart, "auto_send", { outcome: "not_sent", at: now.toISOString(), reasons });
  await audit(business, "Payroll Not Sent Automatically", weekStart, { weekStart, reasons }, AUTO_APPROVAL_ACTOR);
  const recipients = payrollNotifyEmails();
  if (!recipients.length) return { action: "not_sent", reasons, emailed: false };
  const email = autoSendSkippedEmail({ business, weekStart, reasons, link: payrollControlLink(business, weekStart) });
  let emailed = false;
  let configured = true;
  try {
    const delivery = await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text, idempotencyKey: `payroll-not-sent-${business}-${weekStart}`.replace(/\s+/g, "-") });
    emailed = delivery.sent > 0;
    configured = delivery.configured;
  } catch (error) {
    console.error("[payroll-auto-send] not-sent email failed", error);
  }
  // Undelivered (but email is set up): decide again next run, so the owner is told.
  if (!emailed && configured) await releaseNotice(business, weekStart, "auto_send");
  return { action: "not_sent", reasons, emailed };
}

/**
 * Called every 15 minutes (with the missed clock-out check): the Monday summary for both businesses
 * (8 AM, or when Sunday's punches arrive, at the latest noon) and Corner Deli's 5 PM automatic approval.
 */
export async function catchUpPayrollApprovals(now = new Date()) {
  const weekStart = mondayJobWeek(now);
  const results: Record<string, unknown> = {};
  for (const business of ["Corner Deli", "Tiki"] as const) {
    const summary = await sendMondaySummary(business, weekStart, now).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    const autoSend = await autoApprovePayrollWeek(business, weekStart, now).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    results[business] = { summary, autoSend };
  }
  return { weekStart, results };
}

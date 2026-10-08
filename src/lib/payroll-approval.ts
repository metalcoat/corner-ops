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
  payrollSubmissionEmail,
  submissionStatusLine,
  type PayrollEmailRow,
  type SubmissionStatus,
} from "@/lib/missed-clock-out-rules";
import {
  controlledPayrollSummary,
  createPayrollDraft,
  lockPayrollRun,
  payrollCsv,
  reopenPayrollRun,
} from "@/lib/payroll-control";
import { publicTeamBaseUrl } from "@/lib/public-team-url";
import { toIsoTimestamp } from "@/lib/timestamp-values";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import type { Business } from "@/lib/types";
import { addDateKeyDays, currentPayrollWeekStart, payrollWeekBounds } from "@/lib/payroll-week";

/**
 * Monday payroll approval and the AccountantsOffice submission queue.
 * Approving is the existing lock (lockPayrollRun), refused while the week has
 * open punches or unresolved missed clock-outs. Each lock queues one
 * submission; the store server's job takes queued ones from
 * /api/cron/payroll-submissions and reports the outcome there.
 */

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
  const submission = await queuePayrollSubmission({ runId: input.id, business: input.business, weekStart, actor: input.actor });
  return { ...locked, submission };
}

export async function queuePayrollSubmission(input: { runId: string; business: Business; weekStart: string; actor: string }) {
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
    WHERE payroll_run_version_id = ${input.id} AND status = 'queued'
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  return { ...reopened, submissionCancelled: cancelled.length > 0 };
}

/** The owner asks to try a failed submission again. */
export async function retryPayrollSubmission(input: { id: string; business: Business; actor: string }) {
  await ensurePayrollApprovalSchema();
  const rows = await getSql()`
    UPDATE payroll_submissions s SET status = 'queued', message = '', queued_at = NOW(), queued_by = ${input.actor},
      started_at = NULL, finished_at = NULL, confirmation_emailed_at = NULL, updated_at = NOW()
    FROM payroll_run_versions r
    WHERE s.id = ${input.id} AND s.business = ${input.business} AND s.status = 'failed'
      AND r.id = s.payroll_run_version_id AND r.status = 'Locked'
    RETURNING s.id, s.payroll_run_version_id
  ` as unknown as Array<{ id: string; payroll_run_version_id: string }>;
  if (!rows[0]) throw new ValidationError("Only a failed submission of a locked payroll can be sent again.");
  await audit(input.business, "Payroll Submission Retried", String(rows[0].payroll_run_version_id), { submissionId: input.id }, input.actor);
  return { id: input.id, status: "queued", statusLine: submissionStatusLine("queued") };
}

type SubmissionRow = {
  id: string;
  business: Business;
  week_start: string | Date;
  payroll_run_version_id: string;
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
    business: row.business,
    weekStart: weekText(row.week_start),
    payrollRunVersionId: String(row.payroll_run_version_id),
    version: row.version === undefined ? null : Number(row.version),
    status: row.status,
    statusLine: submissionStatusLine(row.status, row.message),
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
      WHERE s.business = ${business}
      ORDER BY s.queued_at DESC LIMIT 50
    ` as unknown as Promise<SubmissionRow[]>,
  ]);
  return { blockers, clockOutCases, submissions: submissions.map(mapSubmission) };
}

// ---------------------------------------------------------------------------
// Store-server job (cron endpoints)

/** Hands queued submissions to the job, with the locked payroll to enter. A run that never reports back fails after 45 minutes. */
export async function takePayrollSubmissions(limit = 3) {
  await ensurePayrollApprovalSchema();
  const sql = getSql();
  await sql`
    UPDATE payroll_submissions SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
      message = 'The submission stopped before finishing. Send it again from payroll.'
    WHERE status = 'submitting' AND started_at < NOW() - INTERVAL '45 minutes'
  `;
  const rows = await sql`
    UPDATE payroll_submissions SET status = 'submitting', started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
    WHERE id IN (
      SELECT s.id FROM payroll_submissions s
      JOIN payroll_run_versions r ON r.id = s.payroll_run_version_id
      WHERE s.status = 'queued' AND r.status = 'Locked'
      ORDER BY s.queued_at LIMIT ${Math.max(1, Math.min(10, limit))}
      FOR UPDATE OF s SKIP LOCKED
    )
    RETURNING id, business, week_start, payroll_run_version_id
  ` as unknown as Array<{ id: string; business: Business; week_start: string | Date; payroll_run_version_id: string }>;
  const submissions = [];
  for (const row of rows) {
    const runs = await sql`
      SELECT version, week_end, payload, locked_by, locked_at FROM payroll_run_versions WHERE id = ${row.payroll_run_version_id} LIMIT 1
    ` as unknown as Array<{ version: number; week_end: string; payload: { rows?: unknown[] }; locked_by: string; locked_at: string }>;
    const run = runs[0];
    const csv = await payrollCsv(String(row.payroll_run_version_id));
    submissions.push({
      id: String(row.id),
      business: row.business,
      weekStart: weekText(row.week_start),
      weekEnd: run?.week_end ?? null,
      payrollRunVersionId: String(row.payroll_run_version_id),
      version: Number(run?.version || 0),
      lockedBy: run?.locked_by || "",
      lockedAt: run?.locked_at ?? null,
      rows: run?.payload?.rows || [],
      csvFileName: csv.fileName,
      csv: csv.csv,
    });
  }
  return submissions;
}

/** The job reports how a submission went; the owner gets one confirmation (or failure) email. */
export async function recordPayrollSubmissionResult(input: { id: string; status: "submitted" | "failed"; message?: string }) {
  await ensurePayrollApprovalSchema();
  const message = String(input.message || "").trim().slice(0, 1000);
  const rows = await getSql()`
    UPDATE payroll_submissions SET status = ${input.status}, message = ${message}, finished_at = NOW(), updated_at = NOW()
    WHERE id::text = ${input.id} AND status = 'submitting'
    RETURNING id, business, week_start, payroll_run_version_id
  ` as unknown as Array<{ id: string; business: Business; week_start: string | Date; payroll_run_version_id: string }>;
  const row = rows[0];
  if (!row) return { recorded: false, reason: "No submission with that id is being sent." };
  const weekStart = weekText(row.week_start);
  await audit(row.business, input.status === "submitted" ? "Payroll Submitted" : "Payroll Submission Failed", String(row.payroll_run_version_id),
    { submissionId: String(row.id), weekStart, message, destination: "AccountantsOffice" }, "AccountantsOffice job");

  let emailed = false;
  const claimed = await getSql()`
    UPDATE payroll_submissions SET confirmation_emailed_at = NOW() WHERE id = ${row.id} AND confirmation_emailed_at IS NULL RETURNING id
  ` as unknown as Array<{ id: string }>;
  const recipients = payrollNotifyEmails();
  if (claimed[0] && recipients.length) {
    const versions = await getSql()`SELECT version FROM payroll_run_versions WHERE id = ${row.payroll_run_version_id} LIMIT 1` as unknown as Array<{ version: number }>;
    const email = payrollSubmissionEmail({
      business: row.business, weekStart, version: Number(versions[0]?.version || 0), status: input.status, message,
      link: payrollControlLink(row.business, weekStart),
    });
    try {
      emailed = (await sendTransactionalEmail({ to: recipients, subject: email.subject, text: email.text })).sent > 0;
    } catch (error) {
      console.error("[payroll-submission] confirmation email failed", error);
    }
    if (!emailed) await getSql()`UPDATE payroll_submissions SET confirmation_emailed_at = NULL WHERE id = ${row.id}`;
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
  ` as unknown as Array<{ id: string; version: number; status: string; payload: { rows?: PayrollEmailRow[]; processingFeeReviewCount?: number } }>;
  const latest = versions[0];
  if (latest?.status === "Locked") return { skipped: true, reason: "Payroll for this week is already approved.", version: Number(latest.version) };

  let draft: { version: number; created: boolean } | { error: string };
  let rows: PayrollEmailRow[] = [];
  let missingSquareFees = 0;
  if (latest) {
    draft = { version: Number(latest.version), created: false };
    rows = latest.payload?.rows || [];
    missingSquareFees = Number(latest.payload?.processingFeeReviewCount || 0);
  } else {
    try {
      const created = await createPayrollDraft({ business, weekStart, actor });
      draft = { version: Number(created.version), created: true };
      rows = created.summary.rows || [];
      missingSquareFees = Number(created.summary.processingFeeReviewCount || 0);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      draft = { error: error.message };
      const summary = await controlledPayrollSummary(business, weekStart);
      rows = summary.rows || [];
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

  const email = payrollApprovalEmail({
    business, weekStart, rows, draft, blockers, missingSquareFees, needsReview: blockers.needsReview,
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

import { timingSafeEqual } from "node:crypto";
import { Resend } from "resend";
import { detectMissedShifts } from "@/lib/attendance";
import { getSql } from "@/lib/db";
import { runExpenseAutomation } from "@/lib/expense-control";
import { payrollSummary } from "@/lib/payroll-summary-rules";
import { evaluateAndNotifyOvertimeRisk } from "@/lib/overtime-risk";
import { generateDueRecurringInvoices } from "@/lib/receivables";
import {
  createOperationIssue,
  ensureIntegrationSchema,
  localDateParts,
  syncAllBankConnections,
  syncSquareConnection,
} from "@/lib/integrations";
import type { Business } from "@/lib/types";
import { syncOperationalWeather } from "@/lib/weather-intelligence";

function previousWeekStart(localDate: string): string {
  const date = new Date(`${localDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10);
}

async function flagOpenTikiPunches(localDate: string) {
  const rows = await getSql()`
    SELECT id, employee_name, clock_in
    FROM time_entries
    WHERE business = 'Tiki' AND clock_out IS NULL
    ORDER BY clock_in
  ` as unknown as Array<{ id: string; employee_name: string; clock_in: string }>;

  for (const row of rows) {
    await getSql()`
      UPDATE time_entries SET status = 'Needs Review', updated_at = NOW()
      WHERE id = ${row.id} AND clock_out IS NULL
    `;
    await createOperationIssue({
      issueKey: `tiki-open-punch:${row.id}:${localDate}`,
      business: "Tiki",
      issueType: "Missing Punch",
      severity: "Warning",
      title: `${row.employee_name} is still clocked in`,
      details: `Clocked in at ${row.clock_in} and had no clock-out when the nightly scheduler ran.`,
      reference: row.id,
    });
  }
  return rows.length;
}

async function checkRezkuFreshness(localDate: string) {
  const rows = await getSql()`
    SELECT imported_at FROM rezku_import_batches ORDER BY imported_at DESC LIMIT 1
  ` as unknown as Array<{ imported_at: string }>;
  const latest = rows[0]?.imported_at ? new Date(rows[0].imported_at).getTime() : 0;
  if (!latest || Date.now() - latest > 36 * 60 * 60 * 1000) {
    await createOperationIssue({
      issueKey: `rezku-stale:${localDate}`,
      business: "Corner Deli",
      issueType: "Rezku Import",
      severity: "Warning",
      title: "Corner Deli Rezku reports are stale",
      details: latest
        ? `The newest Rezku report was imported at ${rows[0].imported_at}.`
        : "No Rezku reports have been imported yet.",
      reference: rows[0]?.imported_at || "none",
    });
    return false;
  }
  return true;
}

async function capturePayrollRun(business: Business, weekStart: string) {
  const summary = await payrollSummary(business, weekStart);
  await getSql()`
    INSERT INTO payroll_runs (
      id, business, week_start, week_end, status, payload, generated_by
    ) VALUES (
      ${crypto.randomUUID()}, ${business}, ${summary.weekStart}, ${summary.weekEnd}, 'Calculated',
      ${JSON.stringify(summary)}::jsonb, 'Nightly scheduler'
    )
    ON CONFLICT (business, week_start) DO UPDATE SET
      week_end = EXCLUDED.week_end,
      payload = EXCLUDED.payload,
      generated_by = EXCLUDED.generated_by,
      updated_at = NOW()
    WHERE payroll_runs.status <> 'Locked'
  `;
  return summary.rows.length;
}

async function emailIssueDigest(details: Record<string, unknown>) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.ALERT_FROM_EMAIL?.trim();
  const to = process.env.ALERT_TO_EMAIL?.trim() || process.env.APP_EMAIL?.trim();
  if (!apiKey || !from || !to) return { sent: false, reason: "Alert email is not configured." };

  const openIssues = await getSql()`
    SELECT severity, title, details
    FROM operation_issues
    WHERE status = 'Open' AND last_seen_at >= NOW() - INTERVAL '26 hours'
    ORDER BY severity DESC, last_seen_at DESC
    LIMIT 30
  ` as unknown as Array<{ severity: string; title: string; details: string }>;
  if (!openIssues.length) return { sent: false, reason: "No new issues." };

  const lines = openIssues.map((issue) => `${issue.severity}: ${issue.title}\n${issue.details}`).join("\n\n");
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from,
    to,
    subject: `Corner Ops nightly review: ${openIssues.length} item${openIssues.length === 1 ? "" : "s"}`,
    text: `${lines}\n\nScheduler details:\n${JSON.stringify(details, null, 2)}`,
  });
  if (result.error) throw new Error(result.error.message);
  return { sent: true, id: result.data?.id };
}

type SchedulerFailure = { step: string; message: string };

async function runSchedulerStep<T>(input: {
  localDate: string;
  step: string;
  details: Record<string, unknown>;
  failures: SchedulerFailure[];
  run: () => Promise<T>;
}): Promise<T | null> {
  try {
    const result = await input.run();
    input.details[input.step] = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.failures.push({ step: input.step, message });
    input.details[input.step] = { error: message };
    try {
      await createOperationIssue({
        issueKey: `scheduler:${input.localDate}:${input.step}`,
        business: "Corner Deli",
        issueType: "Scheduler",
        severity: "Error",
        title: `Nightly step failed: ${input.step}`,
        details: message,
        reference: input.localDate,
      });
    } catch (issueError) {
      input.details[`${input.step}IssueError`] = issueError instanceof Error ? issueError.message : String(issueError);
    }
    return null;
  }
}

export async function runScheduledOperations(input: { force?: boolean; source?: string } = {}) {
  await ensureIntegrationSchema();
  const local = localDateParts();
  const baseRunKey = `nightly:${local.date}`;

  if (!input.force && local.hour !== 3) {
    return { skipped: true, reason: `Local hour is ${local.hour}; scheduler runs at 3 AM America/New_York.` };
  }

  await getSql()`
    UPDATE scheduler_runs SET status = 'Failed', completed_at = NOW(),
      details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('reaped', TRUE, 'reapedAt', NOW(), 'error', 'Stale running scheduler invocation was reaped.')
    WHERE status = 'Running' AND started_at < NOW() - INTERVAL '45 minutes'
  `;

  const priorRuns = input.force ? [] : await getSql()`
    SELECT id, status, run_key, started_at
    FROM scheduler_runs
    WHERE local_date = ${local.date} AND run_key LIKE ${`${baseRunKey}%`}
    ORDER BY started_at
  ` as unknown as Array<{ id: string; status: string; run_key: string; started_at: string }>;
  if (!input.force && priorRuns.some((run) => run.status === 'Success')) {
    return { skipped: true, reason: "This local-date scheduler already completed successfully." };
  }
  if (!input.force && priorRuns.length >= 3) {
    return { skipped: true, reason: "This local-date scheduler reached its three-attempt retry limit." };
  }

  const attempt = input.force ? 0 : priorRuns.length + 1;
  const runKey = input.force ? `${baseRunKey}:manual:${Date.now()}` : `${baseRunKey}:attempt:${attempt}`;
  const inserted = await getSql()`
    INSERT INTO scheduler_runs (id, run_key, local_date, local_hour, status, details)
    VALUES (
      ${crypto.randomUUID()}, ${runKey}, ${local.date}, ${local.hour}, 'Running',
      ${JSON.stringify({ source: input.source || "cron", attempt: input.force ? "manual" : attempt })}::jsonb
    )
    ON CONFLICT (run_key) DO NOTHING
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!inserted[0]) return { skipped: true, reason: "This scheduler attempt is already running." };

  const runId = inserted[0].id;
  const details: Record<string, unknown> = { attempt: input.force ? "manual" : attempt };
  const failures: SchedulerFailure[] = [];

  if (local.weekday === "Mon") {
    const weekStart = previousWeekStart(local.date);
    details.payrollWeekStart = weekStart;
    await runSchedulerStep({ localDate: local.date, step: "payrollCornerDeli", details, failures, run: () => capturePayrollRun("Corner Deli", weekStart) });
    await runSchedulerStep({ localDate: local.date, step: "payrollTiki", details, failures, run: () => capturePayrollRun("Tiki", weekStart) });
  }

  await runSchedulerStep({ localDate: local.date, step: "openTikiPunches", details, failures, run: () => flagOpenTikiPunches(local.date) });
  await runSchedulerStep({ localDate: local.date, step: "rezkuFresh", details, failures, run: () => checkRezkuFreshness(local.date) });
  await runSchedulerStep({ localDate: local.date, step: "weather", details, failures, run: () => syncOperationalWeather() });
  await runSchedulerStep({ localDate: local.date, step: "missedShifts", details, failures, run: () => detectMissedShifts() });
  await runSchedulerStep({
    localDate: local.date,
    step: "overtimeRisk",
    details,
    failures,
    run: async () => {
      const [cornerDeli, tiki] = await Promise.all([
        evaluateAndNotifyOvertimeRisk({ business: "Corner Deli", source: "Nightly scheduler", notify: true }),
        evaluateAndNotifyOvertimeRisk({ business: "Tiki", source: "Nightly scheduler", notify: true }),
      ]);
      return { cornerDeli: cornerDeli.summary, tiki: tiki.summary };
    },
  });
  const bankSync = await runSchedulerStep({ localDate: local.date, step: "bankSync", details, failures, run: () => syncAllBankConnections() });
  if (bankSync?.some((item) => !item.ok)) failures.push({ step: "bankSync", message: `${bankSync.filter((item) => !item.ok).length} bank connection sync(s) failed.` });
  await runSchedulerStep({ localDate: local.date, step: "expenses", details, failures, run: () => runExpenseAutomation() });
  const recurring = await runSchedulerStep({
    localDate: local.date,
    step: "recurringInvoices",
    details,
    failures,
    run: () => generateDueRecurringInvoices({ throughDate: local.date, actor: "Nightly recurring invoice scheduler" }),
  });
  if (recurring?.failures?.length) {
    failures.push({ step: "recurringInvoices", message: `${recurring.failures.length} recurring invoice template(s) failed.` });
    for (const failure of recurring.failures) {
      await createOperationIssue({
        issueKey: `recurring-invoice:${failure.templateId}:${failure.issueDate}`,
        business: failure.business,
        issueType: "Recurring Invoice",
        severity: "Error",
        title: `Recurring invoice failed: ${failure.name}`,
        details: failure.error,
        reference: failure.templateId,
      }).catch(() => undefined);
    }
  }
  await runSchedulerStep({ localDate: local.date, step: "squareSync", details, failures, run: () => syncSquareConnection() });
  await runSchedulerStep({ localDate: local.date, step: "alertEmail", details, failures, run: () => emailIssueDigest({ ...details, failures }) });

  details.failures = failures;
  const status = failures.length ? 'Failed' : 'Success';
  await getSql()`
    UPDATE scheduler_runs SET status = ${status}, details = ${JSON.stringify(details)}::jsonb, completed_at = NOW()
    WHERE id = ${runId}
  `;
  return { ok: failures.length === 0, partial: failures.length > 0, runId, local, failures, details };
}

function safeBearer(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleCronRequest(request: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!safeBearer(request.headers.get("authorization") || "", `Bearer ${expected}`)) {
    return Response.json({ error: "Unauthorized scheduler request." }, { status: 401 });
  }
  return Response.json(await runScheduledOperations({ source: "Vercel Cron" }));
}

import { Resend } from "resend";
import { getSql } from "@/lib/db";
import { payrollSummary } from "@/lib/operations";
import {
  createOperationIssue,
  ensureIntegrationSchema,
  localDateParts,
  syncAllBankConnections,
  syncSquareConnection,
} from "@/lib/integrations";
import type { Business } from "@/lib/types";

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

export async function runScheduledOperations(input: { force?: boolean; source?: string } = {}) {
  await ensureIntegrationSchema();
  const local = localDateParts();
  const runKey = `nightly:${local.date}`;

  if (!input.force && local.hour !== 3) {
    return { skipped: true, reason: `Local hour is ${local.hour}; scheduler runs at 3 AM America/New_York.` };
  }

  const inserted = await getSql()`
    INSERT INTO scheduler_runs (id, run_key, local_date, local_hour, status, details)
    VALUES (
      ${crypto.randomUUID()}, ${input.force ? `${runKey}:manual:${Date.now()}` : runKey},
      ${local.date}, ${local.hour}, 'Running', ${JSON.stringify({ source: input.source || "cron" })}::jsonb
    )
    ON CONFLICT (run_key) DO NOTHING
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!inserted[0]) return { skipped: true, reason: "This local-date scheduler run already completed or is running." };

  const runId = inserted[0].id;
  const details: Record<string, unknown> = {};
  try {
    details.openTikiPunches = await flagOpenTikiPunches(local.date);
    details.rezkuFresh = await checkRezkuFreshness(local.date);
    details.bankSync = await syncAllBankConnections();
    try {
      details.squareSync = await syncSquareConnection();
    } catch (error) {
      details.squareSync = { error: error instanceof Error ? error.message : String(error) };
    }

    if (local.weekday === "Mon") {
      const weekStart = previousWeekStart(local.date);
      details.payrollRuns = {
        cornerDeliRows: await capturePayrollRun("Corner Deli", weekStart),
        tikiRows: await capturePayrollRun("Tiki", weekStart),
        weekStart,
      };
    }

    try {
      details.alertEmail = await emailIssueDigest(details);
    } catch (error) {
      details.alertEmail = { error: error instanceof Error ? error.message : String(error) };
    }

    await getSql()`
      UPDATE scheduler_runs SET status = 'Success', details = ${JSON.stringify(details)}::jsonb, completed_at = NOW()
      WHERE id = ${runId}
    `;
    return { ok: true, runId, local, details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    details.error = message;
    await getSql()`
      UPDATE scheduler_runs SET status = 'Failed', details = ${JSON.stringify(details)}::jsonb, completed_at = NOW()
      WHERE id = ${runId}
    `;
    throw error;
  }
}

export async function handleCronRequest(request: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized scheduler request." }, { status: 401 });
  }
  return Response.json(await runScheduledOperations({ source: "Vercel Cron" }));
}

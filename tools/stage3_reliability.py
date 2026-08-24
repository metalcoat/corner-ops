from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text()
def write(path,text): (ROOT/path).write_text(text)
def rep(path,old,new):
    text=read(path); count=text.count(old)
    if count!=1: raise RuntimeError(f"{path}: expected 1 match, got {count}: {old[:100]!r}")
    write(path,text.replace(old,new,1))
def sub(path,pattern,new):
    text=read(path); out,count=re.subn(pattern,lambda _m:new,text,count=1,flags=re.S)
    if count!=1: raise RuntimeError(f"{path}: expected 1 regex match, got {count}: {pattern[:100]}")
    write(path,out)

# CO-021 / CO-044: resumable Plaid pages, no inline initial backfill, stale-run reaping, newest learned rule wins.
rep('src/lib/integrations.ts','    ORDER BY priority ASC, created_at ASC\n','    ORDER BY priority ASC, created_at DESC\n')
rep('src/lib/integrations.ts','''  await upsertBankAccounts(connectionId, input.business, institution, accountsResult.accounts || []);
  await syncBankConnection(connectionId);
  return { connectionId, institution };
''','''  await upsertBankAccounts(connectionId, input.business, institution, accountsResult.accounts || []);
  return { connectionId, institution, syncPending: true };
''')
rep('src/lib/integrations.ts','''async function startSync(connection: ConnectionRow) {
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO integration_sync_runs (id, connection_id, provider, business, status)
    VALUES (${id}, ${connection.id}, ${connection.provider}, ${connection.business}, 'Running')
  `;
  return id;
}
''','''async function startSync(connection: ConnectionRow) {
  await getSql()`
    UPDATE integration_sync_runs SET status = 'Failed',
      message = CASE WHEN message = '' THEN 'Stale running sync was reaped before retry.' ELSE message END,
      completed_at = NOW()
    WHERE connection_id = ${connection.id} AND status = 'Running'
      AND started_at < NOW() - INTERVAL '20 minutes'
  `;
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO integration_sync_runs (id, connection_id, provider, business, status)
    VALUES (${id}, ${connection.id}, ${connection.provider}, ${connection.business}, 'Running')
  `;
  return id;
}
''')
rep('src/lib/integrations.ts','''      for (const transaction of page.added || []) {
        await upsertPlaidTransaction(connection, transaction, rules);
        added += 1;
      }
''','''      const addedRows = page.added || [];
      for (let offset = 0; offset < addedRows.length; offset += 20) {
        const chunk = addedRows.slice(offset, offset + 20);
        await Promise.all(chunk.map((transaction) => upsertPlaidTransaction(connection, transaction, rules)));
        added += chunk.length;
      }
''')
rep('src/lib/integrations.ts','''      cursor = page.next_cursor;
      hasMore = Boolean(page.has_more);
    }

    const accountsResult''','''      cursor = page.next_cursor;
      await getSql()`
        UPDATE integration_connections SET cursor = ${cursor || ''}, updated_at = NOW()
        WHERE id = ${connection.id} AND business = ${connection.business}
      `;
      hasMore = Boolean(page.has_more);
    }

    const accountsResult''')

# CO-048: one bad recurring template cannot starve every later template.
rep('src/lib/receivables.ts','''  const generated: Array<Record<string, unknown>> = [];
  for (const template of templates) {
    let nextDate = String(template.next_issue_date).slice(0, 10);
    let safety = 0;
    while (nextDate <= throughDate && safety < 24) {
      generated.push({ templateId: template.id, business: template.business, ...(await postInvoice(template, nextDate, input.actor || "Recurring invoice scheduler")) });
      nextDate = advanceIssueDate(nextDate, template.cadence);
      safety += 1;
    }
    await getSql()`
      UPDATE recurring_invoice_templates SET next_issue_date = ${nextDate}, updated_at = NOW()
      WHERE id = ${template.id}
    `;
  }
  return { throughDate, templates: templates.length, created: generated.filter((row) => row.created).length, generated };
''','''  const generated: Array<Record<string, unknown>> = [];
  const failures: Array<{ templateId: string; business: Business; name: string; issueDate: string; error: string }> = [];
  for (const template of templates) {
    let nextDate = String(template.next_issue_date).slice(0, 10);
    let safety = 0;
    try {
      while (nextDate <= throughDate && safety < 24) {
        generated.push({ templateId: template.id, business: template.business, ...(await postInvoice(template, nextDate, input.actor || "Recurring invoice scheduler")) });
        nextDate = advanceIssueDate(nextDate, template.cadence);
        safety += 1;
      }
      await getSql()`
        UPDATE recurring_invoice_templates SET next_issue_date = ${nextDate}, updated_at = NOW()
        WHERE id = ${template.id} AND business = ${template.business}
      `;
    } catch (error) {
      failures.push({
        templateId: template.id,
        business: template.business,
        name: template.name,
        issueDate: nextDate,
        error: error instanceof Error ? error.message : String(error),
      });
      await getSql()`
        UPDATE recurring_invoice_templates SET next_issue_date = ${nextDate}, updated_at = NOW()
        WHERE id = ${template.id} AND business = ${template.business}
      `;
    }
  }
  return { throughDate, templates: templates.length, created: generated.filter((row) => row.created).length, failed: failures.length, failures, generated };
''')

# CO-022: isolate every nightly subsystem, reap stale runs, and permit bounded retries.
sub('src/lib/scheduler.ts',r'export async function runScheduledOperations\(input: \{ force\?: boolean; source\?: string \} = \{\}\) \{.*?\n\}\n\nexport async function handleCronRequest',r'''type SchedulerFailure = { step: string; message: string };

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

export async function handleCronRequest''')

# CO-031: preflight inventory and make the bill/lines/inventory updates one transaction.
sub('src/lib/finance-operations-actions.ts',r'  const id = crypto\.randomUUID\(\);\n  await getSql\(\)`\n    INSERT INTO vendor_bills .*?\n  return \{ id, created: true, lines: lines\.length, totalAmount \};',r'''  const inventoryChecks = await Promise.all(lines.map(async (line, index) => {
    if (!line.inventoryItemId) return null;
    const item = await getSql()`
      SELECT id FROM inventory_items
      WHERE id = ${line.inventoryItemId} AND business = ${input.business} AND active = TRUE
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (!item[0]) throw new Error(`Inventory item on line ${index + 1} was not found for ${input.business}.`);
    return item[0].id;
  }));
  void inventoryChecks;

  const id = crypto.randomUUID();
  const sql = getSql();
  const queries = [
    sql`
      INSERT INTO vendor_bills (
        id, business, vendor, invoice_number, invoice_date, due_date, subtotal, tax_amount,
        total_amount, category, account_code, status, notes, file_name, content_type,
        blob_url, blob_pathname, created_by
      ) VALUES (
        ${id}, ${input.business}, ${vendor}, ${invoiceNumber}, ${invoiceDate}, ${dueDate},
        ${subtotal}, ${taxAmount}, ${totalAmount}, ${clean(input.category, 120) || "Other Expense"},
        ${clean(input.accountCode, 20) || "5900"}, 'Open', ${clean(input.notes, 1500)},
        ${clean(input.fileName, 255)}, ${clean(input.contentType, 160)}, ${clean(input.blobUrl, 1000)},
        ${clean(input.blobPathname, 1000)}, ${clean(input.actor, 240)}
      )
    `,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    queries.push(sql`
      INSERT INTO vendor_bill_lines (
        id, bill_id, line_number, inventory_item_id, description, quantity, unit, unit_price, line_total
      ) VALUES (
        ${crypto.randomUUID()}, ${id}, ${index + 1}, ${line.inventoryItemId}, ${line.description},
        ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.lineTotal}
      )
    `);
    if (line.inventoryItemId && line.unitPrice > 0) {
      queries.push(sql`
        INSERT INTO inventory_purchases (
          id, business, inventory_item_id, vendor, purchase_date, quantity, unit,
          unit_price, total_amount, bill_id, source
        ) VALUES (
          ${crypto.randomUUID()}, ${input.business}, ${line.inventoryItemId}, ${vendor}, ${invoiceDate},
          ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.lineTotal}, ${id}, 'Vendor bill'
        )
      `);
      queries.push(sql`
        UPDATE inventory_items SET
          current_quantity = current_quantity + ${line.quantity},
          preferred_vendor = CASE WHEN preferred_vendor = '' THEN ${vendor} ELSE preferred_vendor END,
          updated_at = NOW()
        WHERE id = ${line.inventoryItemId} AND business = ${input.business}
      `);
    }
  }
  await sql.transaction(queries);

  return { id, created: true, lines: lines.length, totalAmount };''')

# CO-055/063: ingest responds immediately; notification runs after response. Query via indexed event_at.
rep('src/app/api/3cx/inbound/route.ts','import { timingSafeEqual } from "node:crypto";\n','import { timingSafeEqual } from "node:crypto";\nimport { after } from "next/server";\n')
rep('src/app/api/3cx/inbound/route.ts','''    const ingestion = await ingestThreeCxCdr(records);
    const missedCallMessages = records.some(mightNeedMissedCallCheck)
      ? await notifyClockedInDeliEmployeesOfMissedCalls()
      : { skipped: true, reason: "No unanswered Corner Deli queue leg in this CDR batch." };
    return Response.json({ ...ingestion, missedCallMessages }, { status: 202 });
''','''    const ingestion = await ingestThreeCxCdr(records);
    const notificationScheduled = records.some(mightNeedMissedCallCheck);
    if (notificationScheduled) {
      after(async () => {
        try {
          await notifyClockedInDeliEmployeesOfMissedCalls();
        } catch (error) {
          console.error("3CX missed-call notification failed after ingestion", error);
        }
      });
    }
    return Response.json({ ...ingestion, missedCallMessages: notificationScheduled ? { scheduled: true } : { skipped: true, reason: "No unanswered Corner Deli queue leg in this CDR batch." } }, { status: 202 });
''')
rep('src/lib/three-cx-calls-report.ts','''    FROM three_cx_cdr_records
    WHERE COALESCE(ended_at, started_at, received_at) >= ${queryStart.toISOString()}
      AND COALESCE(started_at, ended_at, received_at) < ${queryEnd.toISOString()}
    ORDER BY COALESCE(ended_at, started_at, received_at)
''','''    FROM three_cx_cdr_records
    WHERE event_at >= ${queryStart.toISOString()}
      AND event_at < ${queryEnd.toISOString()}
    ORDER BY event_at
''')
rep('src/lib/three-cx-missed-call-messages.ts',"          ${employee.id}, 'Announcement', ${message}\n","          ${employee.id}, 'Direct', ${message}\n")

# CO-033/034: restore undefined visual tokens and remove the positional Square-card hack.
for marker in ['html[data-business-theme="Corner Deli"] {','html[data-business-theme="Tiki"] {']:
    rep('src/app/business-theme.css', marker, marker + '''
  --theme-accent: var(--accent);
  --theme-accent-text: var(--accent-contrast);
  --theme-accent-contrast: var(--accent-contrast);
  --background: var(--bg);
  --shadow: 0 18px 45px rgb(0 0 0 / 28%);''')
rep('src/app/ops/interface-cleanup.css','''/* Square is a Tiki-only source. Do not show the card while Corner Deli is selected. */
html[data-business-theme="Corner Deli"] .integrationGrid > .integrationCard:nth-child(2) {
  display: none !important;
}

''','')

# CO-075: make stale wallboard state visible rather than showing an old "last sync" as if live.
rep('src/app/deli-board/page.tsx','''  const currentStaff = schedule.filter((shift) => shift.current);
  const upcomingStaff = schedule.filter((shift) => !shift.current && new Date(shift.starts_at).getTime() > now.getTime()).slice(0, 5);

  return <main className="deliBoard">
''','''  const currentStaff = schedule.filter((shift) => shift.current);
  const upcomingStaff = schedule.filter((shift) => !shift.current && new Date(shift.starts_at).getTime() > now.getTime()).slice(0, 5);
  const generatedAt = new Date(data.generatedAt).getTime();
  const staleMinutes = Number.isFinite(generatedAt) ? Math.max(0, Math.floor((now.getTime() - generatedAt) / 60_000)) : 999;
  const stale = staleMinutes >= 3;

  return <main className="deliBoard">
''')
rep('src/app/deli-board/page.tsx','''    {notice && <div className="boardNotice">{notice}</div>}

    <section className="boardStats">
''','''    {notice && <div className="boardNotice">{notice}</div>}
    {stale && <div className="boardNotice">Live data is stale: the last successful board refresh was {staleMinutes} minute{staleMinutes === 1 ? "" : "s"} ago.</div>}

    <section className="boardStats">
''')

# CO-067 dead client helper is no longer part of the source of truth.
dead = ROOT / 'src/app/ops/workforce/overnight-shift-helper.tsx'
if dead.exists(): dead.unlink()

print('Stage 3 reliability transformations applied')

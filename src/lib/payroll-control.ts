import { ensureSchema, getSql } from "@/lib/db";
import { ValidationError } from "@/lib/http";
import { payrollSummary } from "@/lib/payroll-summary-rules";
import { payrollWeekBounds as weekBounds } from "@/lib/payroll-week";
import { toIsoTimestamp } from "@/lib/timestamp-values";
import { compareScheduleToWorked, payrollDisplayCsvRows, payrollDisplayRows, type ScheduleComparison } from "@/lib/payroll-schedule-compare";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

type PayrollRow = {
  employee: string;
  hours: number;
  regularHours: number;
  overtimeHours: number;
  driverTipHours: number;
  tips: number;
  pickupTips: number;
  deliveryTips: number;
  manualTips?: number;
};

type PayrollSnapshot = {
  business: Business;
  source: string;
  processingFeeReviewCount?: number;
  weekStart: string;
  weekEnd: string;
  rows: PayrollRow[];
  tipDetails: Array<Record<string, unknown>>;
  overrides: Array<Record<string, unknown>>;
  unmatchedTips: Array<Record<string, unknown>>;
  /** Scheduled vs worked per employee (added 2026-10; older saved versions don't have it). */
  scheduleComparison?: ScheduleComparison[];
};

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function ensurePayrollControlSchema(): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS time_entry_adjustments (
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      source_type TEXT NOT NULL CHECK (source_type IN ('Tiki', 'Rezku')),
      source_id UUID NOT NULL,
      before_state JSONB NOT NULL,
      after_state JSONB NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS time_entry_adjustments_source_idx ON time_entry_adjustments (source_type, source_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS tip_overrides (
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      week_start DATE NOT NULL,
      source_transaction_id TEXT NOT NULL DEFAULT '',
      employee_name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS tip_overrides_week_idx ON tip_overrides (business, week_start, created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS payroll_run_versions (
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      week_start DATE NOT NULL,
      week_end TIMESTAMPTZ NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Locked')),
      payload JSONB NOT NULL,
      generated_by TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_by TEXT,
      locked_at TIMESTAMPTZ,
      reopened_from_id UUID REFERENCES payroll_run_versions(id),
      UNIQUE (business, week_start, version)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS payroll_run_versions_week_idx ON payroll_run_versions (business, week_start DESC, version DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS payroll_audit_events (
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      event_type TEXT NOT NULL,
      reference_id TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS payroll_audit_events_business_idx ON payroll_audit_events (business, created_at DESC)`;
}

async function listTipOverrides(business: Business, weekStart: string) {
  const rows = await getSql()`
    SELECT id, business, week_start, source_transaction_id, employee_name, amount, reason, actor, created_at
    FROM tip_overrides
    WHERE business = ${business} AND week_start = ${weekStart}
    ORDER BY created_at
  ` as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id,
    sourceTransactionId: row.source_transaction_id,
    employeeName: row.employee_name,
    amount: numberValue(row.amount),
    reason: row.reason,
    actor: row.actor,
    createdAt: row.created_at,
  }));
}

async function unmatchedTips(business: Business, weekStart: string, allocatedDetails: Array<Record<string, unknown>>) {
  const bounds = weekBounds(weekStart);
  if (business === "Corner Deli") {
    const rows = await getSql()`
      SELECT id, transaction_id, order_id, transaction_time, tip
      FROM rezku_transactions
      WHERE transaction_time >= ${bounds.start.toISOString()} AND transaction_time < ${bounds.end.toISOString()}
        AND tip <> 0
      ORDER BY transaction_time
    ` as unknown as Array<Record<string, unknown>>;
    const allocated = new Set(allocatedDetails.map((detail) => `${detail.orderId || ""}|${detail.time || ""}`));
    return rows.filter((row) => !allocated.has(`${row.order_id || ""}|${new Date(String(row.transaction_time)).toISOString()}`))
      .map((row) => ({
        id: row.id,
        source: "Rezku",
        transactionId: row.transaction_id,
        orderId: row.order_id,
        time: row.transaction_time,
        tip: numberValue(row.tip),
      }));
  }

  const rows = await getSql()`
    SELECT id, external_payment_id, order_id, created_at_square, tip_amount
    FROM square_payments
    WHERE created_at_square >= ${bounds.start.toISOString()} AND created_at_square < ${bounds.end.toISOString()}
      AND status = 'COMPLETED' AND tip_amount <> 0
    ORDER BY created_at_square
  ` as unknown as Array<Record<string, unknown>>;
  const overrides = await getSql()`
    SELECT source_transaction_id FROM tip_overrides
    WHERE business = 'Tiki' AND week_start = ${weekStart} AND source_transaction_id <> ''
  ` as unknown as Array<{ source_transaction_id: string }>;
  const assigned = new Set([
    ...overrides.map((row) => row.source_transaction_id),
    ...allocatedDetails
      .filter((detail) => String(detail.employee || "") !== "Unallocated" && numberValue(detail.allocatedTip) !== 0)
      .map((detail) => String(detail.transactionId || detail.sourceTransactionId || "")),
  ].filter(Boolean));
  return rows.filter((row) => !assigned.has(String(row.external_payment_id))).map((row) => ({
    id: row.id,
    source: "Square",
    transactionId: row.external_payment_id,
    orderId: row.order_id,
    time: row.created_at_square,
    tip: numberValue(row.tip_amount),
  }));
}

export async function controlledPayrollSummary(business: Business, weekStart: string): Promise<PayrollSnapshot> {
  await ensurePayrollControlSchema();
  const base = await payrollSummary(business, weekStart) as unknown as PayrollSnapshot;
  const overrides = await listTipOverrides(business, weekStart);
  const rows = (base.rows || []).map((row) => ({ ...row, manualTips: 0 }));
  const byEmployee = new Map(rows.map((row) => [row.employee, row]));
  for (const override of overrides) {
    const employee = String(override.employeeName);
    const amount = numberValue(override.amount);
    const row = byEmployee.get(employee) || {
      employee,
      hours: 0,
      regularHours: 0,
      overtimeHours: 0,
      driverTipHours: 0,
      tips: 0,
      pickupTips: 0,
      deliveryTips: 0,
      manualTips: 0,
    };
    row.manualTips = roundMoney(numberValue(row.manualTips) + amount);
    row.tips = roundMoney(numberValue(row.tips) + amount);
    byEmployee.set(employee, row);
  }
  const mappedRows = Array.from(byEmployee.values()).sort((a, b) => a.employee.localeCompare(b.employee));
  return {
    ...base,
    business,
    rows: mappedRows,
    scheduleComparison: await scheduleComparisonFor(business, weekStart, mappedRows),
    overrides,
    unmatchedTips: await unmatchedTips(business, weekStart, base.tipDetails || []),
  };
}

/** Rezku shows "Ken" as "Can"; the payroll summary uses Ken, so the schedule comparison does too. */
function canonicalName(value: unknown): string {
  const name = String(value ?? "").trim();
  return /^can$/i.test(name) ? "Ken" : name;
}

/**
 * Scheduled vs worked for the payroll week (Monday 4 AM to Monday 4 AM): the week's published schedule
 * shifts against the punches payroll used (Corner Deli: Rezku shifts, matched by name; Tiki: time
 * entries, matched by employee id). Never stops payroll: on an error the comparison is left empty.
 */
export async function scheduleComparisonFor(business: Business, weekStart: string, rows: PayrollRow[]): Promise<ScheduleComparison[]> {
  try {
    const bounds = weekBounds(weekStart);
    const start = bounds.start.toISOString(), end = bounds.end.toISOString();
    // Punches a little outside the week still show a shift at the edge was worked.
    const near = new Date(bounds.start.getTime() - 18 * 3_600_000).toISOString();
    const after = new Date(bounds.end.getTime() + 18 * 3_600_000).toISOString();
    const [shiftRows, punchRows] = await Promise.all([
      getSql()`
        SELECT s.employee_id, e.name AS employee_name, s.starts_at, s.ends_at
        FROM schedule_shifts s
        JOIN employees e ON e.id = s.employee_id
        WHERE s.business = ${business} AND s.status = 'Published'
          AND s.starts_at >= ${start} AND s.starts_at < ${end}
      `,
      business === "Tiki"
        ? getSql()`
            SELECT employee_id, employee_name, clock_in, clock_out FROM time_entries
            WHERE business = 'Tiki' AND COALESCE(clock_in, clock_out) >= ${near} AND COALESCE(clock_in, clock_out) < ${after}
          `
        : getSql()`
            SELECT NULL::uuid AS employee_id, employee_name, clock_in, clock_out FROM rezku_shifts
            WHERE COALESCE(clock_in, clock_out) >= ${near} AND COALESCE(clock_in, clock_out) < ${after}
          `,
    ]) as unknown as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];
    return compareScheduleToWorked({
      rows,
      shifts: shiftRows.map((row) => ({
        employeeId: row.employee_id ? String(row.employee_id) : null, employeeName: canonicalName(row.employee_name),
        startsAt: toIsoTimestamp(row.starts_at) || "", endsAt: toIsoTimestamp(row.ends_at) || "",
      })),
      punches: punchRows.map((row) => ({
        employeeId: row.employee_id ? String(row.employee_id) : null, employeeName: canonicalName(row.employee_name),
        clockIn: toIsoTimestamp(row.clock_in), clockOut: toIsoTimestamp(row.clock_out),
      })),
    });
  } catch (error) {
    console.error("[payroll] scheduled vs worked could not be calculated", error);
    return [];
  }
}

// Keep older callers on the same validated, optional-note correction implementation.
export { correctPunch } from "./payroll-punch-correction";

export async function createTipOverride(input: {
  business: Business;
  weekStart: string;
  sourceTransactionId?: string;
  employeeName: string;
  amount: number;
  reason: string;
  actor: string;
}) {
  await ensurePayrollControlSchema();
  weekBounds(input.weekStart);
  const employee = clean(input.employeeName, 120);
  const reason = clean(input.reason, 1000);
  const amount = roundMoney(Number(input.amount || 0));
  if (!employee) throw new Error("Choose an employee.");
  if (!amount) throw new Error("Override amount cannot be zero.");
  if (reason.length < 3) throw new Error("Explain the tip override.");
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO tip_overrides (
      id, business, week_start, source_transaction_id, employee_name, amount, reason, actor
    ) VALUES (
      ${id}, ${input.business}, ${input.weekStart}, ${clean(input.sourceTransactionId, 180)},
      ${employee}, ${amount}, ${reason}, ${input.actor}
    )
  `;
  await getSql()`
    INSERT INTO payroll_audit_events (id, business, event_type, reference_id, details, actor)
    VALUES (${crypto.randomUUID()}, ${input.business}, 'Tip Override Created', ${id},
      ${JSON.stringify({ weekStart: input.weekStart, employee, amount, reason, sourceTransactionId: input.sourceTransactionId || "" })}::jsonb, ${input.actor})
  `;
  return { id };
}

export async function deleteTipOverride(id: string, actor: string) {
  await ensurePayrollControlSchema();
  const rows = await getSql()`
    DELETE FROM tip_overrides WHERE id = ${id}
    RETURNING business, week_start, employee_name, amount, reason
  ` as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new Error("Tip override was not found.");
  await getSql()`
    INSERT INTO payroll_audit_events (id, business, event_type, reference_id, details, actor)
    VALUES (
      ${crypto.randomUUID()}, ${rows[0].business}, 'Tip Override Deleted', ${id},
      ${JSON.stringify(rows[0])}::jsonb, ${actor}
    )
  `;
  return { deleted: true };
}

export async function createPayrollDraft(input: { business: Business; weekStart: string; actor: string; reopenedFromId?: string }) {
  await ensurePayrollControlSchema();
  const summary = await controlledPayrollSummary(input.business, input.weekStart);
  if (input.business === "Tiki" && summary.processingFeeReviewCount) {
    throw new ValidationError(`Square processing fees are missing for ${summary.processingFeeReviewCount} tipped payment(s). Sync Square and recalculate before creating a payroll draft.`);
  }
  const versions = await getSql()`
    SELECT COALESCE(MAX(version), 0)::INTEGER AS version
    FROM payroll_run_versions WHERE business = ${input.business} AND week_start = ${input.weekStart}
  ` as unknown as Array<{ version: number }>;
  const version = Number(versions[0]?.version || 0) + 1;
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO payroll_run_versions (
      id, business, week_start, week_end, version, status, payload, generated_by, reopened_from_id
    ) VALUES (
      ${id}, ${input.business}, ${input.weekStart}, ${summary.weekEnd}, ${version}, 'Draft',
      ${JSON.stringify(summary)}::jsonb, ${input.actor}, ${input.reopenedFromId || null}
    )
  `;
  await getSql()`
    INSERT INTO payroll_audit_events (id, business, event_type, reference_id, details, actor)
    VALUES (${crypto.randomUUID()}, ${input.business}, ${input.reopenedFromId ? 'Payroll Reopened' : 'Payroll Draft Created'}, ${id},
      ${JSON.stringify({ weekStart: input.weekStart, version, reopenedFromId: input.reopenedFromId || null })}::jsonb, ${input.actor})
  `;
  return { id, version, status: "Draft", summary };
}

export async function lockPayrollRun(id: string, actor: string) {
  await ensurePayrollControlSchema();
  const rows = await getSql()`
    UPDATE payroll_run_versions SET status = 'Locked', locked_by = ${actor}, locked_at = NOW()
    WHERE id = ${id} AND status = 'Draft'
    RETURNING id, business, week_start, version
  ` as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new Error("Only a draft payroll version can be locked.");
  await getSql()`
    INSERT INTO payroll_audit_events (id, business, event_type, reference_id, details, actor)
    VALUES (${crypto.randomUUID()}, ${rows[0].business}, 'Payroll Locked', ${id}, ${JSON.stringify(rows[0])}::jsonb, ${actor})
  `;
  return { locked: true, run: rows[0] };
}

export async function reopenPayrollRun(id: string, actor: string) {
  await ensurePayrollControlSchema();
  const rows = await getSql()`
    SELECT id, business, week_start::text AS week_start FROM payroll_run_versions WHERE id = ${id} AND status = 'Locked' LIMIT 1
  ` as unknown as Array<{ id: string; business: Business; week_start: string }>;
  if (!rows[0]) throw new Error("Only a locked payroll version can be reopened.");
  return createPayrollDraft({ business: rows[0].business, weekStart: String(rows[0].week_start), actor, reopenedFromId: id });
}

export async function payrollCsv(id: string): Promise<{ fileName: string; csv: string }> {
  await ensurePayrollControlSchema();
  const rows = await getSql()`
    SELECT business, week_start::text AS week_start, version, payload FROM payroll_run_versions WHERE id = ${id} LIMIT 1
  ` as unknown as Array<{ business: Business; week_start: string; version: number; payload: PayrollSnapshot }>;
  const run = rows[0];
  if (!run) throw new Error("Payroll version was not found.");
  // Saved versions from before the schedule comparison existed get it calculated now.
  const comparison = run.payload.scheduleComparison
    || await scheduleComparisonFor(run.business, String(run.week_start).slice(0, 10), run.payload.rows || []);
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = payrollDisplayCsvRows(payrollDisplayRows(run.payload.rows || [], comparison)).map((cells) => cells.map(quote).join(","));
  return {
    fileName: `${run.business.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-payroll-${run.week_start}-v${run.version}.csv`,
    csv: `${lines.join("\r\n")}\r\n`,
  };
}

export async function payrollControlDashboard(business: Business, weekStart: string) {
  await ensurePayrollControlSchema();
  const bounds = weekBounds(weekStart);
  const summary = await controlledPayrollSummary(business, weekStart);
  const punches = business === "Tiki"
    ? await getSql()`
        SELECT id, employee_name, position, clock_in, clock_out, status, notes, source
        FROM time_entries
        WHERE business = 'Tiki' AND clock_in >= ${bounds.start.toISOString()} AND clock_in < ${bounds.end.toISOString()}
        ORDER BY clock_in
      `
    : await getSql()`
        SELECT id, employee_name, position, clock_in, clock_out,
          CASE WHEN clock_out IS NULL THEN 'Needs Review' ELSE 'Complete' END AS status,
          raw->>'correctionReason' AS notes, 'Rezku' AS source
        FROM rezku_shifts
        WHERE clock_in >= ${bounds.start.toISOString()} AND clock_in < ${bounds.end.toISOString()}
        ORDER BY clock_in
      `;
  const versions = await getSql()`
    SELECT id, business, week_start, week_end, version, status, generated_by, generated_at,
      locked_by, locked_at, reopened_from_id
    FROM payroll_run_versions
    WHERE business = ${business}
    ORDER BY week_start DESC, version DESC LIMIT 50
  ` as unknown as Array<Record<string, unknown>>;
  const adjustments = await getSql()`
    SELECT id, source_type, source_id, before_state, after_state, reason, actor, created_at
    FROM time_entry_adjustments
    WHERE business = ${business} AND created_at >= ${bounds.start.toISOString()} - INTERVAL '14 days'
    ORDER BY created_at DESC LIMIT 100
  ` as unknown as Array<Record<string, unknown>>;
  const auditEvents = await getSql()`
    SELECT id, event_type, reference_id, details, actor, created_at
    FROM payroll_audit_events WHERE business = ${business}
    ORDER BY created_at DESC LIMIT 100
  ` as unknown as Array<Record<string, unknown>>;
  return {
    summary,
    punches: (punches as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      employeeName: row.employee_name,
      position: row.position,
      clockIn: row.clock_in,
      clockOut: row.clock_out,
      status: row.status,
      notes: row.notes || "",
      source: row.source,
    })),
    versions: versions.map((row) => ({
      id: row.id,
      business: row.business,
      weekStart: row.week_start,
      weekEnd: row.week_end,
      version: row.version,
      status: row.status,
      generatedBy: row.generated_by,
      generatedAt: row.generated_at,
      lockedBy: row.locked_by,
      lockedAt: row.locked_at,
      reopenedFromId: row.reopened_from_id,
    })),
    adjustments: adjustments.map((row) => ({
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      beforeState: row.before_state,
      afterState: row.after_state,
      reason: row.reason,
      actor: row.actor,
      createdAt: row.created_at,
    })),
    auditEvents: auditEvents.map((row) => ({
      id: row.id, eventType: row.event_type, referenceId: row.reference_id,
      details: row.details, actor: row.actor, createdAt: row.created_at,
    })),
  };
}
import { getSql } from "@/lib/db";
import {
  controlledPayrollSummary,
  ensurePayrollControlSchema,
} from "@/lib/payroll-control";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

function getOffsetMilliseconds(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return represented - date.getTime();
}

function zonedDateToUtc(dateText: string, hour: number): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  let timestamp = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let index = 0; index < 2; index += 1) {
    timestamp = Date.UTC(year, month - 1, day, hour, 0, 0)
      - getOffsetMilliseconds(new Date(timestamp), TIME_ZONE);
  }
  return new Date(timestamp);
}

function weekBounds(weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error("Choose a valid payroll week.");
  const start = zonedDateToUtc(weekStart, 4);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const adjustmentStart = new Date(start.getTime() - 14 * 24 * 60 * 60 * 1000);
  return { start, end, adjustmentStart };
}

function timestamp(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function easternLabel(value: unknown): string | null {
  const iso = timestamp(value);
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export async function safePayrollControlDashboard(business: Business, weekStart: string) {
  await ensurePayrollControlSchema();
  const bounds = weekBounds(weekStart);
  const summary = await controlledPayrollSummary(business, weekStart);
  const punches = business === "Tiki"
    ? await getSql()`
        SELECT id, employee_name, position, clock_in, clock_out, status, notes, source
        FROM time_entries
        WHERE business = 'Tiki'
          AND clock_in >= ${bounds.start.toISOString()}
          AND clock_in < ${bounds.end.toISOString()}
        ORDER BY clock_in
      `
    : await getSql()`
        SELECT id, employee_name, position, clock_in, clock_out,
          CASE WHEN clock_out IS NULL THEN 'Needs Review' ELSE 'Complete' END AS status,
          raw->>'correctionReason' AS notes, 'Rezku' AS source
        FROM rezku_shifts
        WHERE clock_in >= ${bounds.start.toISOString()}
          AND clock_in < ${bounds.end.toISOString()}
        ORDER BY clock_in
      `;
  const versions = await getSql()`
    SELECT id, business, week_start, week_end, version, status, generated_by, generated_at,
      locked_by, locked_at, reopened_from_id
    FROM payroll_run_versions
    WHERE business = ${business}
    ORDER BY week_start DESC, version DESC
    LIMIT 50
  ` as unknown as Array<Record<string, unknown>>;
  const adjustments = await getSql()`
    SELECT id, source_type, source_id, before_state, after_state, reason, actor, created_at
    FROM time_entry_adjustments
    WHERE business = ${business}
      AND created_at >= ${bounds.adjustmentStart.toISOString()}
    ORDER BY created_at DESC
    LIMIT 100
  ` as unknown as Array<Record<string, unknown>>;
  const auditEvents = await getSql()`
    SELECT id, event_type, reference_id, details, actor, created_at
    FROM payroll_audit_events
    WHERE business = ${business}
    ORDER BY created_at DESC
    LIMIT 100
  ` as unknown as Array<Record<string, unknown>>;

  return {
    summary,
    punches: (punches as unknown as Array<Record<string, unknown>>).map((row) => {
      const clockIn = timestamp(row.clock_in);
      const clockOut = timestamp(row.clock_out);
      return {
        id: row.id,
        employeeName: row.employee_name,
        position: row.position,
        clockIn,
        clockOut,
        clockInEastern: easternLabel(row.clock_in),
        clockOutEastern: easternLabel(row.clock_out),
        status: row.status,
        notes: row.notes || "",
        source: row.source,
      };
    }),
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
      id: row.id,
      eventType: row.event_type,
      referenceId: row.reference_id,
      details: row.details,
      actor: row.actor,
      createdAt: row.created_at,
    })),
  };
}

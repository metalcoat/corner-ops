import { nyFoodServiceRates, tipCreditShortfallCents, tippedFullRateCents, tippedOvertimeRateCents } from "@/lib/ny-tipped-wage";
import { overtimePayCents, weightedAverageOvertimeCents } from "@/lib/payroll-overtime-rules";
import { getSql } from "@/lib/db";
import {
  controlledPayrollSummary,
  ensurePayrollControlSchema,
} from "@/lib/payroll-control";
import { addDateKeyDays, payrollWeekBounds } from "@/lib/payroll-week";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

function weekBounds(weekStart: string) {
  const { start, end } = payrollWeekBounds(weekStart);
  const adjustmentStart = payrollWeekBounds(addDateKeyDays(weekStart, -14)).start;
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
        SELECT id, employee_name, position, clock_in, clock_out,
          CASE WHEN clock_in IS NULL OR clock_out IS NULL THEN 'Needs Review' ELSE status END AS status,
          notes, source
        FROM time_entries
        WHERE business = 'Tiki'
          AND (
            (clock_in >= ${bounds.start.toISOString()} AND clock_in < ${bounds.end.toISOString()})
            OR (clock_in IS NULL AND clock_out >= ${bounds.start.toISOString()} AND clock_out < ${bounds.end.toISOString()})
          )
        ORDER BY COALESCE(clock_in, clock_out)
      `
    : await getSql()`
        SELECT r.id, r.employee_name,
          COALESCE(NULLIF(BTRIM(r.position), ''), scheduled.position, '') AS position,
          r.clock_in, r.clock_out,
          CASE WHEN r.clock_in IS NULL OR r.clock_out IS NULL THEN 'Needs Review' ELSE 'Complete' END AS status,
          r.raw->>'correctionReason' AS notes, 'Rezku' AS source
        FROM rezku_shifts r
        LEFT JOIN LATERAL (
          SELECT s.position
          FROM schedule_shifts s
          JOIN employees e ON e.id = s.employee_id
          WHERE s.business = 'Corner Deli'
            AND s.status = 'Published'
            AND LOWER(BTRIM(e.name)) = LOWER(BTRIM(r.employee_name))
            AND s.starts_at < COALESCE(r.clock_out, r.clock_in + INTERVAL '18 hours')
            AND s.ends_at > COALESCE(r.clock_in, r.clock_out - INTERVAL '18 hours')
          ORDER BY ABS(EXTRACT(EPOCH FROM (s.starts_at - COALESCE(r.clock_in, r.clock_out))))
          LIMIT 1
        ) scheduled ON TRUE
        WHERE (
          (r.clock_in >= ${bounds.start.toISOString()} AND r.clock_in < ${bounds.end.toISOString()})
          OR (r.clock_in IS NULL AND r.clock_out >= ${bounds.start.toISOString()} AND r.clock_out < ${bounds.end.toISOString()})
        )
        ORDER BY COALESCE(r.clock_in, r.clock_out)
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

  // Drivers: cash wage + delivery tips for their tipped hours must reach the full NY minimum (tip credit check).
  const year = Number(weekStart.slice(0, 4)) || new Date().getFullYear();
  const rates = business === "Corner Deli"
    ? await getSql()`SELECT name, hourly_rate, tipped_rate FROM employees WHERE business = ${business}` as unknown as Array<{ name: string; hourly_rate: string | number; tipped_rate: string | number }>
    : [];
  const tippedRateByName = new Map(rates.map((row) => [String(row.name).trim().toLowerCase(), Math.round(Number(row.tipped_rate || 0) * 100)]));
  const regularRateByName = new Map(rates.map((row) => [String(row.name).trim().toLowerCase(), Math.round(Number(row.hourly_rate || 0) * 100)]));
  // Second overtime rule: overtime priced by the role each hour past 40 fell in.
  // By-role overtime needs the employee's signed agreement (two-rate pay notice); otherwise the weighted average applies.
  const agreed = business === "Corner Deli"
    ? new Set((await getSql()`
        SELECT DISTINCT LOWER(BTRIM(e.name)) AS name FROM employment_forms f JOIN employees e ON e.id = f.employee_id
        WHERE f.business = ${business} AND f.form_type = 'PAY_NOTICE' AND f.overtime_by_role_agreement AND f.status IN ('Employee Signed', 'Completed')
      ` as unknown as Array<{ name: string }>).map((row) => row.name))
    : new Set<string>();
  const overtimeByRole = ((summary.rows || []) as Array<{ employee: string; overtimeRegularHours?: number; overtimeTippedHours?: number; straightRegularHoursByRole?: number; straightTippedHoursByRole?: number }>)
    .filter((row) => Number(row.overtimeRegularHours || 0) + Number(row.overtimeTippedHours || 0) > 0)
    .map((row) => {
      const key = String(row.employee).trim().toLowerCase();
      const regularRateCents = regularRateByName.get(key) || 0;
      const tippedRate = tippedRateByName.get(key) || 0;
      const tippedOtRateCents = tippedRate ? tippedOvertimeRateCents(tippedRate, year) : Math.round(1.5 * regularRateCents);
      const split = { regularStraightHours: Number(row.straightRegularHoursByRole || 0), tippedStraightHours: Number(row.straightTippedHoursByRole || 0), regularOvertimeHours: Number(row.overtimeRegularHours || 0), tippedOvertimeHours: Number(row.overtimeTippedHours || 0) };
      const pay = overtimePayCents(split, { regularRateCents, tippedOvertimeRateCents: tippedOtRateCents });
      const signedAgreement = agreed.has(key);
      const weightedCents = weightedAverageOvertimeCents(split, { regularRateCents, tippedCashRateCents: tippedRate || regularRateCents, tippedFullRateCents: tippedRate ? tippedFullRateCents(tippedRate, year) : regularRateCents });
      return { employee: row.employee, inStoreHours: split.regularOvertimeHours, inStoreRateCents: Math.round(1.5 * regularRateCents), drivingHours: split.tippedOvertimeHours, drivingRateCents: tippedOtRateCents, ...pay, signedAgreement, weightedCents, payCents: signedAgreement ? pay.totalCents : weightedCents };
    });
  const tipCreditShortfalls = ((summary.rows || []) as Array<{ employee: string; driverTipHours?: number; deliveryTips?: number }>)
    .map((row) => {
      const tippedRateCents = tippedRateByName.get(String(row.employee).trim().toLowerCase()) || 0;
      const shortfallCents = tipCreditShortfallCents({ tippedHours: Number(row.driverTipHours || 0), tippedRateCents, tipsCents: Math.round(Number(row.deliveryTips || 0) * 100), year });
      return { employee: row.employee, tippedHours: Number(row.driverTipHours || 0), tippedRateCents, deliveryTipsCents: Math.round(Number(row.deliveryTips || 0) * 100), shortfallCents };
    })
    .filter((row) => row.shortfallCents > 0);

  return {
    summary,
    tipCreditShortfalls,
    overtimeByRole,
    minimumWageCents: nyFoodServiceRates(year).minimumCents,
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

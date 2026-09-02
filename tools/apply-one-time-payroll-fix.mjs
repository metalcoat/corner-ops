import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// This guarded script runs only during the production deployment and is removed after verification.
const productionBuild = process.env.VERCEL_ENV === "production";
const databaseUrl = process.env.DATABASE_URL?.trim();
const diagnosticPath = "public/payroll-fix-20260829-kayli.json";

if (!databaseUrl || !productionBuild) {
  console.log("One-time payroll fix skipped outside the production Vercel build.");
  process.exit(0);
}

const sql = neon(databaseUrl);
const entryId = "780b4d63-93d5-4937-9f9f-0f46bd51abe3";
const auditId = "a64ead2f-46ab-40ab-935e-cbd301d395e6";
const clockIn = "2026-08-29T23:00:00.000Z";
const clockOut = "2026-08-30T05:30:00.000Z";

let diagnostic;
try {
  const [result] = await sql`
    WITH matching AS (
      SELECT id, name, COALESCE(NULLIF(BTRIM(position), ''), 'Bartender') AS position
      FROM employees
      WHERE business = 'Tiki'
        AND active = TRUE
        AND LOWER(BTRIM(name)) LIKE 'kayli%'
    ),
    target AS (
      SELECT *
      FROM matching
      WHERE (SELECT COUNT(*) FROM matching) = 1
    ),
    overlaps AS (
      SELECT t.id, t.clock_in, t.clock_out
      FROM time_entries t
      JOIN target employee ON employee.id = t.employee_id
      WHERE t.clock_in < ${clockOut}::timestamptz
        AND COALESCE(t.clock_out, 'infinity'::timestamptz) > ${clockIn}::timestamptz
    ),
    inserted AS (
      INSERT INTO time_entries (
        id, business, employee_id, employee_name, position, role_group,
        clock_in, clock_out, source, status, notes
      )
      SELECT
        ${entryId}::uuid, 'Tiki', employee.id, employee.name, employee.position, 'In-House',
        ${clockIn}::timestamptz, ${clockOut}::timestamptz,
        'Manager Added', 'Corrected',
        'Manager added by Chris: employee missed both punches for the Aug 29, 2026 shift.'
      FROM target employee
      WHERE NOT EXISTS (SELECT 1 FROM overlaps)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    ),
    audited AS (
      INSERT INTO manual_time_entry_audit (
        id, business, source_type, source_id, employee_id, employee_name,
        action, actor, details
      )
      SELECT
        ${auditId}::uuid, 'Tiki', 'Corner Ops', entry.id, entry.employee_id,
        entry.employee_name, 'Manager Added', 'Chris',
        jsonb_build_object(
          'clockIn', ${clockIn}::text,
          'clockOut', ${clockOut}::text,
          'hours', 6.5,
          'position', entry.position,
          'note', 'Employee missed both punches for the Aug 29, 2026 shift.'
        )
      FROM time_entries entry
      JOIN target employee ON employee.id = entry.employee_id
      WHERE entry.id = ${entryId}::uuid
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    SELECT
      (SELECT COUNT(*)::int FROM matching) AS matched_employees,
      (SELECT COUNT(*)::int FROM overlaps) AS overlapping_entries,
      (SELECT COUNT(*)::int FROM overlaps WHERE clock_out IS NULL) AS open_overlaps,
      (SELECT COUNT(*)::int FROM overlaps
        WHERE clock_in <= ${clockIn}::timestamptz
          AND clock_out >= ${clockOut}::timestamptz) AS covering_overlaps,
      (SELECT COUNT(*)::int FROM inserted) AS inserted_entries,
      (SELECT COUNT(*)::int FROM time_entries WHERE id = ${entryId}::uuid) AS saved_entries,
      (SELECT COUNT(*)::int FROM manual_time_entry_audit WHERE id = ${auditId}::uuid) AS saved_audits
  `;

  const matched = Number(result?.matched_employees || 0);
  const overlaps = Number(result?.overlapping_entries || 0);
  const openOverlaps = Number(result?.open_overlaps || 0);
  const coveringOverlaps = Number(result?.covering_overlaps || 0);
  const inserted = Number(result?.inserted_entries || 0);
  const saved = Number(result?.saved_entries || 0);
  const audits = Number(result?.saved_audits || 0);
  const status = saved === 1 && audits === 1
    ? "saved"
    : matched !== 1
      ? "employee-match-error"
      : coveringOverlaps > 0
        ? "existing-shift-covers-request"
        : openOverlaps > 0
          ? "open-overlap"
          : overlaps > 0
            ? "partial-overlap"
            : "not-saved";

  diagnostic = {
    status,
    generatedAt: new Date().toISOString(),
    matchedEmployees: matched,
    overlappingEntries: overlaps,
    openOverlaps,
    coveringOverlaps,
    insertedEntries: inserted,
    savedEntries: saved,
    savedAudits: audits,
  };
} catch (error) {
  diagnostic = {
    status: "query-error",
    generatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
console.log(`Kayli Aug 29 payroll fix diagnostic: ${JSON.stringify(diagnostic)}.`);

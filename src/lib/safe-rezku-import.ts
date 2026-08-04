import { getSql } from "@/lib/db";
import { importRezkuReport } from "@/lib/operations";
import { repairRezkuBatchTimes } from "@/lib/rezku-eastern-time";
import { normalizeRezkuWorkbook } from "@/lib/rezku-workbook-normalize";

async function cleanRezkuShifts(batchId: string) {
  const sql = getSql();

  // Cover is the only worksheet that is not a data source.
  await sql`
    DELETE FROM rezku_shifts
    WHERE batch_id = ${batchId}::uuid
      AND LOWER(BTRIM(employee_name)) = 'cover'
  `;

  await sql`
    UPDATE rezku_shifts
    SET employee_name = 'Ken'
    WHERE LOWER(BTRIM(employee_name)) = 'can'
  `;

  // Detailed Labor contains employee totals with hours but no punch timestamps.
  // Those rows are summaries, not shifts or missing-punch exceptions.
  await sql`
    DELETE FROM rezku_shifts
    WHERE clock_in IS NULL AND clock_out IS NULL
  `;

  // Detailed Labor and Shift Attestation can both contain the same punch.
  // Keep one copy, preferring the row that includes a Rezku position.
  await sql`
    WITH ranked AS (
      SELECT s.id,
        ROW_NUMBER() OVER (
          PARTITION BY LOWER(BTRIM(s.employee_name)), s.clock_in, s.clock_out
          ORDER BY
            CASE WHEN BTRIM(s.position) <> '' THEN 0 ELSE 1 END,
            CASE WHEN LOWER(COALESCE(s.raw->>'__sheet', '')) = 'main' THEN 1 ELSE 0 END,
            b.imported_at ASC,
            s.id
        ) AS duplicate_rank
      FROM rezku_shifts s
      JOIN rezku_import_batches b ON b.id = s.batch_id
      WHERE s.clock_in IS NOT NULL AND s.clock_out IS NOT NULL
    )
    DELETE FROM rezku_shifts s
    USING ranked r
    WHERE s.id = r.id AND r.duplicate_rank > 1
  `;

  // A unique Main punch may not carry a position. When Rezku reported exactly one
  // position for that employee that day, use it without rewriting imported history.
  await sql`
    WITH inferred AS (
      SELECT target.id, MIN(source.position) AS position
      FROM rezku_shifts target
      JOIN rezku_shifts source
        ON LOWER(BTRIM(source.employee_name)) = LOWER(BTRIM(target.employee_name))
       AND (source.clock_in AT TIME ZONE 'America/New_York')::date
         = (target.clock_in AT TIME ZONE 'America/New_York')::date
       AND BTRIM(source.position) <> ''
      WHERE BTRIM(target.position) = ''
        AND target.clock_in IS NOT NULL
      GROUP BY target.id
      HAVING COUNT(DISTINCT source.position) = 1
    )
    UPDATE rezku_shifts target
    SET position = inferred.position,
        role_group = CASE
          WHEN LOWER(inferred.position) LIKE '%training%' OR LOWER(inferred.position) LIKE '%trainee%' THEN 'Ignore'
          WHEN LOWER(inferred.position) LIKE '%driver%' OR LOWER(inferred.position) LIKE '%delivery%' THEN 'Driver'
          ELSE 'In-House'
        END
    FROM inferred
    WHERE target.id = inferred.id
  `;
}

export async function importSafeRezkuReport(
  fileName: string,
  bytes: ArrayBuffer,
  requestedType: string | undefined,
  actor: string,
) {
  const normalizedBytes = normalizeRezkuWorkbook(fileName, bytes, requestedType);
  const result = await importRezkuReport(fileName, normalizedBytes, requestedType, actor);

  if (result.reportType === "shifts") {
    await cleanRezkuShifts(result.batchId);
  }

  const repaired = await repairRezkuBatchTimes(result.batchId);
  if (result.reportType === "shifts") {
    // Time repair can reveal a duplicate that originally had null or incorrectly zoned timestamps.
    await cleanRezkuShifts(result.batchId);
  }

  const counts = await getSql()`
    SELECT COUNT(*)::INTEGER AS imported
    FROM (
      SELECT id FROM rezku_shifts WHERE batch_id = ${result.batchId}::uuid
      UNION ALL
      SELECT id FROM rezku_orders WHERE batch_id = ${result.batchId}::uuid
      UNION ALL
      SELECT id FROM rezku_transactions WHERE batch_id = ${result.batchId}::uuid
    ) imported_rows
  ` as unknown as Array<{ imported: number }>;

  return {
    ...result,
    imported: Number(counts[0]?.imported || 0),
    repaired,
  };
}

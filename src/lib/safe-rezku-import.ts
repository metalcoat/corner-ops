import { getSql } from "@/lib/db";
import { importRezkuReport } from "@/lib/operations";
import { repairRezkuBatchTimes } from "@/lib/rezku-eastern-time";
import { normalizeRezkuWorkbook } from "@/lib/rezku-workbook-normalize";

export async function importSafeRezkuReport(
  fileName: string,
  bytes: ArrayBuffer,
  requestedType: string | undefined,
  actor: string,
) {
  const normalizedBytes = normalizeRezkuWorkbook(fileName, bytes, requestedType);
  const result = await importRezkuReport(fileName, normalizedBytes, requestedType, actor);

  if (result.reportType === "shifts") {
    const sql = getSql();
    await sql`
      DELETE FROM rezku_shifts
      WHERE batch_id = ${result.batchId}::uuid
        AND LOWER(BTRIM(employee_name)) = 'cover'
    `;
    await sql`
      UPDATE rezku_shifts
      SET employee_name = 'Ken'
      WHERE batch_id = ${result.batchId}::uuid
        AND LOWER(BTRIM(employee_name)) = 'can'
    `;
  }

  const repaired = await repairRezkuBatchTimes(result.batchId);
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

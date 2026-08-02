import { getSql } from "@/lib/db";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLEANUP_TOKEN = "cancel-last-week-import-2026-08-02";

export async function GET(request: Request) {
  try {
    if (process.env.VERCEL_ENV !== "preview") {
      return Response.json({ error: "Cleanup is preview-only." }, { status: 403 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get("token") !== CLEANUP_TOKEN) {
      return Response.json({ error: "Cleanup token is invalid." }, { status: 403 });
    }

    const sql = getSql();
    const batches = await sql`
      SELECT id
      FROM rezku_import_batches
      WHERE imported_by IN (
        'Historical Google Sheets import',
        'Historical last-week replacement',
        'One-time last-week replacement'
      )
      OR file_name = 'Rezku punches 2026-07-20 through 2026-07-26'
    ` as unknown as Array<{ id: string }>;

    let deletedShifts = 0;
    let deletedBatches = 0;

    for (const batch of batches) {
      const shifts = await sql`
        DELETE FROM rezku_shifts
        WHERE batch_id = ${batch.id}::uuid
        RETURNING id
      ` as unknown as Array<{ id: string }>;
      deletedShifts += shifts.length;

      const removed = await sql`
        DELETE FROM rezku_import_batches
        WHERE id = ${batch.id}::uuid
        RETURNING id
      ` as unknown as Array<{ id: string }>;
      deletedBatches += removed.length;
    }

    const stray = await sql`
      DELETE FROM rezku_shifts
      WHERE COALESCE(raw->>'historicalImport', 'false') = 'true'
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    deletedShifts += stray.length;

    const remaining = await sql`
      SELECT COUNT(*)::INTEGER AS count
      FROM rezku_shifts
    ` as unknown as Array<{ count: number }>;

    return Response.json({ deletedShifts, deletedBatches, remainingRezkuShifts: remaining[0]?.count || 0 });
  } catch (error) {
    return apiError(error);
  }
}

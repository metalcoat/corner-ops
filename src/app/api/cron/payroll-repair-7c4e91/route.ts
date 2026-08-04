import { getSql } from "@/lib/db";
import { repairExistingRezkuTimesOnce } from "@/lib/rezku-eastern-time";
import { payrollSummary } from "@/lib/payroll-summary-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sql = getSql();
  await sql`DELETE FROM rezku_data_migrations WHERE migration_key = 'rezku-wall-times-america-new-york-v2'`;
  const repair = await repairExistingRezkuTimesOnce();
  const summary = await payrollSummary("Corner Deli", "2026-07-27");
  return Response.json({ repair, summary });
}

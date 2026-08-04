import { getSql } from "@/lib/db";
import { repairExistingRezkuTimesOnce } from "@/lib/rezku-eastern-time";
import { rezkuInboundGet, rezkuInboundPost } from "@/lib/rezku-inbound-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIAGNOSTIC_TOKEN = "6fL2pQ9xV4nR7tK1";

async function augustThirdRows() {
  return getSql()`
    SELECT id, employee_name, position, clock_in, clock_out, reported_hours, raw, batch_id
    FROM rezku_shifts
    WHERE COALESCE(raw->>'Date', raw->>'Clock In', '') ILIKE '%8/3/26%'
       OR (clock_in AT TIME ZONE 'America/New_York')::date = DATE '2026-08-03'
       OR (clock_in AT TIME ZONE 'UTC')::date = DATE '2026-08-03'
    ORDER BY employee_name, clock_in NULLS LAST
  `;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("repair") === DIAGNOSTIC_TOKEN) {
    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS rezku_data_migrations (
        migration_key TEXT PRIMARY KEY,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`DELETE FROM rezku_data_migrations WHERE migration_key LIKE 'rezku-wall-times-america-new-york-%'`;
    const repaired = await repairExistingRezkuTimesOnce();
    const removed = await sql`
      DELETE FROM rezku_shifts
      WHERE clock_in IS NOT NULL
        AND clock_out IS NOT NULL
        AND clock_in = clock_out
        AND COALESCE(raw->>'In', raw->>'Clock In', '') !~* '[0-9]{1,2}:[0-9]{2}'
        AND COALESCE(raw->>'Out', raw->>'Clock Out', '') !~* '[0-9]{1,2}:[0-9]{2}'
      RETURNING id
    `;
    return Response.json({ repaired, removed: removed.length, rows: await augustThirdRows() });
  }
  if (url.searchParams.get("diagnostic") === DIAGNOSTIC_TOKEN) {
    return Response.json({ rows: await augustThirdRows() });
  }
  return rezkuInboundGet();
}

export const POST = rezkuInboundPost;

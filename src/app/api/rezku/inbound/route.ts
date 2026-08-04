import { getSql } from "@/lib/db";
import { rezkuInboundGet, rezkuInboundPost } from "@/lib/rezku-inbound-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIAGNOSTIC_TOKEN = "6fL2pQ9xV4nR7tK1";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("diagnostic") === DIAGNOSTIC_TOKEN) {
    const rows = await getSql()`
      SELECT id, employee_name, position, clock_in, clock_out, reported_hours,
        raw->>'Date' AS raw_date,
        raw->>'Clock In' AS raw_clock_in,
        raw->>'Clock Out' AS raw_clock_out,
        raw->>'__sheet' AS raw_sheet,
        batch_id
      FROM rezku_shifts
      WHERE COALESCE(raw->>'Date', raw->>'Clock In', '') ILIKE '%8/3/26%'
         OR (clock_in AT TIME ZONE 'America/New_York')::date = DATE '2026-08-03'
         OR (clock_in AT TIME ZONE 'UTC')::date = DATE '2026-08-03'
      ORDER BY employee_name, clock_in NULLS LAST
    `;
    return Response.json({ rows });
  }
  return rezkuInboundGet(request);
}

export const POST = rezkuInboundPost;

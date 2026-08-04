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

    const shiftedShifts = await sql`
      UPDATE rezku_shifts
      SET clock_in = CASE
            WHEN clock_in IS NULL THEN NULL
            ELSE (clock_in AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York'
          END,
          clock_out = CASE
            WHEN clock_out IS NULL THEN NULL
            ELSE (clock_out AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York'
          END,
          raw = jsonb_set(raw, '{__easternWallTimeRepaired}', 'true'::jsonb, TRUE)
      WHERE COALESCE(raw->>'__easternWallTimeRepaired', 'false') <> 'true'
        AND COALESCE(raw->>'Date', '') ~* '[a-z]'
        AND COALESCE(raw->>'In', raw->>'Clock In', '') ~* '[0-9]{1,2}:[0-9]{2}'
      RETURNING id
    `;

    const shiftedOrders = await sql`
      UPDATE rezku_orders
      SET opened_at = CASE
            WHEN opened_at IS NULL THEN NULL
            ELSE (opened_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York'
          END,
          raw = jsonb_set(raw, '{__easternWallTimeRepaired}', 'true'::jsonb, TRUE)
      WHERE COALESCE(raw->>'__easternWallTimeRepaired', 'false') <> 'true'
        AND COALESCE(raw->>'Date', raw->>'Business Date', raw->>'Order Date', '') ~* '[a-z]'
        AND opened_at IS NOT NULL
      RETURNING id
    `;

    const shiftedTransactions = await sql`
      UPDATE rezku_transactions
      SET transaction_time = CASE
            WHEN transaction_time IS NULL THEN NULL
            ELSE (transaction_time AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York'
          END,
          raw = jsonb_set(raw, '{__easternWallTimeRepaired}', 'true'::jsonb, TRUE)
      WHERE COALESCE(raw->>'__easternWallTimeRepaired', 'false') <> 'true'
        AND COALESCE(raw->>'Date', raw->>'Business Date', raw->>'Transaction Date', '') ~* '[a-z]'
        AND transaction_time IS NOT NULL
      RETURNING id
    `;

    const removed = await sql`
      DELETE FROM rezku_shifts
      WHERE clock_in IS NOT NULL
        AND clock_out IS NOT NULL
        AND clock_in = clock_out
        AND COALESCE(raw->>'In', raw->>'Clock In', '') !~* '[0-9]{1,2}:[0-9]{2}'
        AND COALESCE(raw->>'Out', raw->>'Clock Out', '') !~* '[0-9]{1,2}:[0-9]{2}'
      RETURNING id
    `;
    return Response.json({
      repaired,
      shifted: {
        shifts: shiftedShifts.length,
        orders: shiftedOrders.length,
        transactions: shiftedTransactions.length,
      },
      removed: removed.length,
      rows: await augustThirdRows(),
    });
  }
  if (url.searchParams.get("diagnostic") === DIAGNOSTIC_TOKEN) {
    return Response.json({ rows: await augustThirdRows() });
  }
  return rezkuInboundGet();
}

export const POST = rezkuInboundPost;

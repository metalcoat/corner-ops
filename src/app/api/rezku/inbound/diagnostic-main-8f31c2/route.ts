import { getSql } from "@/lib/db";
import { retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN = "Yf3v2kU8rP6nQ1sM9xL4bC7dH5jA0eW2";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("token") !== TOKEN) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const sql = getSql();
  const emails = await sql`
    SELECT email_id, report_date, status, reports_found, reports_processed, received_at
    FROM rezku_inbound_emails
    WHERE report_date = DATE '2026-08-03'
    ORDER BY received_at DESC
    LIMIT 1
  ` as unknown as Array<{
    email_id: string;
    report_date: string;
    status: string;
    reports_found: number;
    reports_processed: number;
    received_at: string;
  }>;

  let retry: Record<string, unknown> | null = null;
  if (emails[0]) {
    const result = await retryRezkuInboundEmail(emails[0].email_id, "temporary August 3 diagnostic");
    retry = result.payload;
  }

  const batches = await sql`
    SELECT b.id, b.file_name, b.report_type, b.row_count, b.imported_at, b.imported_by,
      COUNT(s.id)::INTEGER AS stored_shift_rows,
      COUNT(*) FILTER (WHERE s.clock_in IS NULL)::INTEGER AS missing_clock_in,
      COUNT(*) FILTER (WHERE s.clock_out IS NULL)::INTEGER AS missing_clock_out
    FROM rezku_import_batches b
    LEFT JOIN rezku_shifts s ON s.batch_id = b.id
    WHERE b.report_type = 'shifts'
      AND b.imported_at >= TIMESTAMPTZ '2026-08-03 00:00:00-04'
    GROUP BY b.id, b.file_name, b.report_type, b.row_count, b.imported_at, b.imported_by
    ORDER BY b.imported_at DESC
    LIMIT 20
  `;

  const shifts = await sql`
    SELECT employee_name, position,
      TO_CHAR(clock_in AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS clock_in_et,
      TO_CHAR(clock_out AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS clock_out_et,
      raw->>'__sheet' AS sheet,
      batch_id
    FROM rezku_shifts
    WHERE clock_in >= TIMESTAMPTZ '2026-08-03 04:00:00-04'
      AND clock_in < TIMESTAMPTZ '2026-08-04 04:00:00-04'
    ORDER BY clock_in, employee_name
  `;

  const nullClockRows = await sql`
    SELECT employee_name, position, raw->>'__sheet' AS sheet, batch_id,
      LEFT(raw::text, 1200) AS raw_sample
    FROM rezku_shifts
    WHERE clock_in IS NULL
      AND batch_id IN (
        SELECT id FROM rezku_import_batches
        WHERE report_type = 'shifts'
          AND imported_at >= TIMESTAMPTZ '2026-08-03 00:00:00-04'
      )
    ORDER BY employee_name
    LIMIT 30
  `;

  return Response.json({ email: emails[0] || null, retry, batches, shifts, nullClockRows });
}

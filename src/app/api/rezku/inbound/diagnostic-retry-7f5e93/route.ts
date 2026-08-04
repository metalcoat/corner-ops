import { getSql } from "@/lib/db";
import { retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ONE_TIME_TOKEN = "jHRm5iddoIYpZYjmE3t8oXlea2KpEtY8";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (token !== ONE_TIME_TOKEN) return Response.json({ error: "Not found." }, { status: 404 });

  const rows = await getSql()`
    SELECT email_id, report_date, status
    FROM rezku_inbound_emails
    WHERE status IN ('Failed', 'Partial')
    ORDER BY received_at DESC
    LIMIT 1
  ` as unknown as Array<{ email_id: string; report_date: string | null; status: string }>;
  if (!rows[0]) return Response.json({ error: "No failed Rezku email was found." }, { status: 404 });

  const result = await retryRezkuInboundEmail(rows[0].email_id, "one-time production diagnostic");
  return Response.json({ email: rows[0], result: result.payload }, { status: 200 });
}

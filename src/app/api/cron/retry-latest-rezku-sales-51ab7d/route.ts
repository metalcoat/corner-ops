import { getSql } from "@/lib/db";
import { retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const rows = await getSql()`
    SELECT email_id, report_date, received_at
    FROM rezku_inbound_emails
    ORDER BY received_at DESC
    LIMIT 1
  ` as unknown as Array<{ email_id: string; report_date: string | null; received_at: string }>;
  const latest = rows[0];
  if (!latest) return Response.json({ error: "No Rezku email receipt was found." }, { status: 404 });
  const result = await retryRezkuInboundEmail(latest.email_id, "One-time Sales by Product integration");
  return Response.json({ latest, result });
}

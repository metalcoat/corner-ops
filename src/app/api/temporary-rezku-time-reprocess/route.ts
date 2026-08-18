import { retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TOKEN = "8p9hMC6eR9-6nn1Q72vMS5Q8iX8yE1wLVY2TaqhHTXM";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const rows = await getSql()`
    SELECT email_id, report_date
    FROM rezku_inbound_emails
    WHERE report_date >= DATE '2026-08-10'
      AND report_date <= DATE '2026-08-16'
      AND subject = 'Corner Deli Daily Reports'
    ORDER BY report_date, received_at DESC
  ` as unknown as Array<{ email_id: string; report_date: string }>;

  const seen = new Set<string>();
  const targets = rows.filter((row) => {
    const date = String(row.report_date).slice(0, 10);
    if (seen.has(date)) return false;
    seen.add(date);
    return true;
  });

  const results: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    try {
      const retry = await retryRezkuInboundEmail(target.email_id, "temporary timestamp reprocess");
      results.push({
        reportDate: String(target.report_date).slice(0, 10),
        emailId: target.email_id,
        statusCode: retry.statusCode,
        payload: retry.payload,
      });
    } catch (error) {
      results.push({
        reportDate: String(target.report_date).slice(0, 10),
        emailId: target.email_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Response.json({ targetCount: targets.length, results });
}

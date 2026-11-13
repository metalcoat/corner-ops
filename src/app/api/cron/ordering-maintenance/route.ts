import { isoJson } from "@/lib/timestamp-values";
import { timingSafeEqual } from "node:crypto";
import { runOrderingMaintenance } from "@/lib/ordering-maintenance";
import { maybeSendNightlyTillEmail } from "@/lib/ordering-registers";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Retries failed/abandoned print jobs, restores abandoned reopened orders, and sends the nightly till email when due.
// Schedule every minute on the host; the kitchen display poll also runs the
// same sweeps opportunistically.
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  // Also the nightly till email once its deadline (45 min after close) passes with a till still not closed out.
  const tillEmail = await maybeSendNightlyTillEmail().catch((error) => ({ error: error instanceof Error ? error.message : "till email failed" }));
  return isoJson({ results: [await runOrderingMaintenance("Corner Deli"), await runOrderingMaintenance("Tiki")], tillEmail });
}

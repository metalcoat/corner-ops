import { isoJson } from "@/lib/timestamp-values";
import { timingSafeEqual } from "node:crypto";
import { runOrderingMaintenance } from "@/lib/ordering-maintenance";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Retries failed/abandoned print jobs and restores abandoned reopened orders.
// Schedule every minute on the host; the kitchen display poll also runs the
// same sweeps opportunistically.
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  return isoJson({ results: [await runOrderingMaintenance("Corner Deli"), await runOrderingMaintenance("Tiki")] });
}

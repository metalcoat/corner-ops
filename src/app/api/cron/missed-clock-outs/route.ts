import { isoJson } from "@/lib/timestamp-values";
import { timingSafeEqual } from "node:crypto";
import { runMissedClockOutCheck } from "@/lib/missed-clock-outs";
import { catchUpPayrollApprovals } from "@/lib/payroll-approval";

export const runtime = "nodejs";
export const maxDuration = 120;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Every 15 minutes: forgotten clock-outs from both clocks (see runMissedClockOutCheck): time clock punches
 * still open an hour after close are closed at the scheduled end (else closing time) and marked for review;
 * Rezku punches clocked out an hour or more past the scheduled end become cases. The employee is texted
 * when they have SMS consent; the owner gets one email per business. Then Monday payroll: the 8 AM summary
 * and the 5 PM automatic approval. ?dryRun=1 lists what would happen without saving or sending anything.
 */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const clockOuts = await runMissedClockOutCheck({ dryRun });
    // Monday payroll: the 8 AM summary and the 5 PM automatic approval (see catchUpPayrollApprovals).
    const payrollApproval = dryRun ? null : await catchUpPayrollApprovals().catch((error) => {
      console.error("[payroll-approval]", error);
      return { error: "Payroll approval could not be prepared." };
    });
    return isoJson({ ...clockOuts, payrollApproval });
  } catch (error) {
    console.error("[missed-clock-outs]", error);
    return isoJson({ error: "Missed clock-outs could not be checked." }, { status: 500 });
  }
}

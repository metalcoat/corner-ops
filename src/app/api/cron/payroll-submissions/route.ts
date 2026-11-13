import { isoJson } from "@/lib/timestamp-values";
import { timingSafeEqual } from "node:crypto";
import {
  autoApprovePayrollWeek,
  claimPayrollSubmitPress,
  payrollSubmissionDetails,
  payrollSubmissionPreview,
  recordMondaySummarySent,
  recordPayrollReliefRoster,
  recordPayrollSubmissionResult,
  takePayrollSubmissionCode,
  takePayrollSubmissions,
  PAYROLL_RELIEF_BUSINESS,
} from "@/lib/payroll-approval";
import { mondayJobWeek } from "@/lib/payroll-auto-rules";
import type { HoursTotals, RosterEntry } from "@/lib/payroll-relief-timesheet";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * For the Payroll Relief job on the store server (deploy/supplier-scraper/payroll-relief.mjs):
 *   ?submissions=1          approved Corner Deli payrolls (and Check AccountantsOffice requests) waiting;
 *                           each one handed out is marked "submitting" and includes the rows, mapping and CSV.
 *   ?submission=<id>        one submission's details. Changes nothing.
 *   ?preview=1&business=Corner Deli&weekStart=YYYY-MM-DD
 *                           the same details from the week's latest payroll version, for a dry run. Changes nothing.
 *   ?code=<id>              the sign-in code the owner typed on the payroll page (handed out once).
 */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  const url = new URL(request.url);
  try {
    if (url.searchParams.get("submissions")) return isoJson({ submissions: await takePayrollSubmissions() });
    const id = url.searchParams.get("submission");
    if (id) {
      const submission = await payrollSubmissionDetails(id);
      return submission ? isoJson({ submission }) : isoJson({ error: "No submission with that id." }, { status: 404 });
    }
    if (url.searchParams.get("preview")) {
      const business = url.searchParams.get("business") || PAYROLL_RELIEF_BUSINESS;
      if (business !== "Corner Deli" && business !== "Tiki") return isoJson({ error: "Unknown business." }, { status: 400 });
      const submission = await payrollSubmissionPreview(business, String(url.searchParams.get("weekStart") || ""));
      return submission ? isoJson({ submission }) : isoJson({ error: "No payroll version for that week. Create a draft first." }, { status: 404 });
    }
    const codeFor = url.searchParams.get("code");
    if (codeFor) return isoJson({ code: await takePayrollSubmissionCode(codeFor) });
  } catch (error) {
    console.error("[payroll-submissions]", error);
    const message = error instanceof Error && error.name === "ValidationError" ? error.message : "Payroll submissions could not be loaded.";
    return isoJson({ error: message }, { status: 500 });
  }
  return isoJson({ error: "Ask for submissions, submission, preview or code." }, { status: 400 });
}

/**
 * The job reports:
 *   { "roster": [{ "num": "26", "name": "Allen  Gregory M.", "payType": "H" }, ...] }   Payroll Relief's employees
 *   { "id": "<submission id>", "submitPressing": true }   about to press Submit: answers { granted } and records
 *                                                         submit_pressed_at first; Submit is pressed only when granted
 *   { "id": "<submission id>", "status": "needs_code" | "submitted" | "sent" | "failed", "message": "...", "totals": { reg, tipHours, tips, ot } }
 *   { "summarySent": { "weekStart": "YYYY-MM-DD", "sentAt": "<ISO>" } }   the Monday summary went out from elsewhere
 *                                                         (staging, until the switch); Corner Deli
 *   { "autoApprove": true }   Corner Deli's 8 PM Monday automatic approval for this Monday's week, if due
 *                             (the same decision as the missed clock-out job's; for staging's send job)
 * "submitted" = saved in Payroll Relief for the owner to review and Submit; "sent" = Submit pressed and confirmed.
 * The owner is emailed when a code is needed, and once when it is saved, sent or failed.
 */
export async function POST(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: string; status?: string; message?: string; totals?: HoursTotals; roster?: RosterEntry[]; submitPressing?: boolean; summarySent?: { weekStart?: string; sentAt?: string }; autoApprove?: boolean };
    if (Array.isArray(body.roster)) return isoJson(await recordPayrollReliefRoster(PAYROLL_RELIEF_BUSINESS, body.roster));
    if (body.summarySent) return isoJson(await recordMondaySummarySent(PAYROLL_RELIEF_BUSINESS, String(body.summarySent.weekStart || ""), new Date(String(body.summarySent.sentAt || ""))));
    if (body.autoApprove === true) {
      const weekStart = mondayJobWeek(new Date());
      return isoJson({ weekStart, ...(await autoApprovePayrollWeek(PAYROLL_RELIEF_BUSINESS, weekStart)) });
    }
    const id = String(body.id || "").trim();
    if (!id) return isoJson({ error: "Send the submission id." }, { status: 400 });
    if (body.submitPressing === true) {
      const claim = await claimPayrollSubmitPress(id);
      return isoJson(claim, { status: claim.granted ? 200 : 409 });
    }
    if (body.status !== "submitted" && body.status !== "sent" && body.status !== "failed" && body.status !== "needs_code") {
      return isoJson({ error: "status must be needs_code, submitted, sent or failed." }, { status: 400 });
    }
    const result = await recordPayrollSubmissionResult({ id, status: body.status, message: String(body.message || ""), totals: body.totals || null });
    return isoJson(result, { status: result.recorded ? 200 : 409 });
  } catch (error) {
    console.error("[payroll-submissions]", error);
    return isoJson({ error: "The payroll submission result could not be saved." }, { status: 500 });
  }
}

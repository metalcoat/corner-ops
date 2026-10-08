import { isoJson } from "@/lib/timestamp-values";
import { timingSafeEqual } from "node:crypto";
import { recordPayrollSubmissionResult, takePayrollSubmissions } from "@/lib/payroll-approval";

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
 * For the AccountantsOffice job on the store server:
 *   ?submissions=1   approved (locked) payrolls waiting to be entered; each one
 *                    handed out is marked "submitting" and includes the rows and CSV.
 */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  const url = new URL(request.url);
  if (url.searchParams.get("submissions")) {
    try {
      return isoJson({ submissions: await takePayrollSubmissions() });
    } catch (error) {
      console.error("[payroll-submissions]", error);
      return isoJson({ error: "Payroll submissions could not be loaded." }, { status: 500 });
    }
  }
  return isoJson({ error: "Ask for submissions." }, { status: 400 });
}

/**
 * The job reports the outcome of one submission:
 *   { "id": "<submission id>", "status": "submitted" | "failed", "message": "confirmation number or error" }
 * The owner is emailed a confirmation (or the failure).
 */
export async function POST(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: string; status?: string; message?: string };
    const id = String(body.id || "").trim();
    if (!id) return isoJson({ error: "Send the submission id." }, { status: 400 });
    if (body.status !== "submitted" && body.status !== "failed") return isoJson({ error: "status must be submitted or failed." }, { status: 400 });
    const result = await recordPayrollSubmissionResult({ id, status: body.status, message: String(body.message || "") });
    return isoJson(result, { status: result.recorded ? 200 : 409 });
  } catch (error) {
    console.error("[payroll-submissions]", error);
    return isoJson({ error: "The payroll submission result could not be saved." }, { status: 500 });
  }
}

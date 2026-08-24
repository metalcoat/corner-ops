import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { apiError } from "@/lib/http";
import { ingestThreeCxCdr, type ThreeCxCdrInput } from "@/lib/three-cx-cdr";
import { notifyClockedInDeliEmployeesOfMissedCalls } from "@/lib/three-cx-missed-call-messages";

export const runtime = "nodejs";
export const maxDuration = 60;

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: Request): boolean {
  const expected = process.env.THREE_CX_CDR_SECRET?.trim();
  const supplied = request.headers.get("x-corner-ops-cdr-secret")?.trim()
    || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(expected && supplied && equal(expected, supplied));
}

function recordField(record: ThreeCxCdrInput, ...names: string[]): unknown {
  for (const name of names) {
    const direct = record[name];
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") return direct;
    const normalized = name.replace(/[-_\s]/g, "").toLowerCase();
    const key = Object.keys(record).find((candidate) => candidate.replace(/[-_\s]/g, "").toLowerCase() === normalized);
    if (key && record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") return record[key];
  }
  return "";
}

function endpointIncludesQueue(value: unknown, queue: string): boolean {
  const target = queue.replace(/\D/g, "");
  if (!target) return false;
  return String(value ?? "").split(/[^0-9]+/).filter(Boolean).some((token) => token === target);
}

function mightNeedMissedCallCheck(record: ThreeCxCdrInput): boolean {
  if (String(recordField(record, "missed-queue-calls", "missed_queue_calls", "missedQueueCalls")).trim()) return true;

  const answered = String(recordField(record, "time-answered", "time_answered", "answeredAt")).trim();
  const ended = String(recordField(record, "time-end", "time_end", "endedAt")).trim();
  if (answered || !ended) return false;

  const queue = process.env.THREE_CX_DELI_QUEUE || "90";
  return endpointIncludesQueue([
    recordField(record, "to-no", "to_no", "toNo"),
    recordField(record, "to-dn", "to_dn", "toDn"),
    recordField(record, "dial-no", "dial_no", "dialNo"),
    recordField(record, "final-number", "final_number", "finalNumber"),
    recordField(record, "final-dn", "final_dn", "finalDn"),
    recordField(record, "chain"),
  ].join(" "), queue);
}

export async function GET() {
  return Response.json({ ok: true, service: "3CX CDR inbound" });
}

export async function POST(request: Request) {
  try {
    if (!authorized(request)) return Response.json({ error: "Invalid 3CX CDR secret." }, { status: 401 });
    const body = await request.json() as { records?: ThreeCxCdrInput[]; record?: ThreeCxCdrInput } | ThreeCxCdrInput[];
    const records = Array.isArray(body) ? body : Array.isArray(body.records) ? body.records : body.record ? [body.record] : [];
    const ingestion = await ingestThreeCxCdr(records);
    const notificationScheduled = records.some(mightNeedMissedCallCheck);
    if (notificationScheduled) {
      after(async () => {
        try {
          await notifyClockedInDeliEmployeesOfMissedCalls();
        } catch (error) {
          console.error("3CX missed-call notification failed after ingestion", error);
        }
      });
    }
    return Response.json({ ...ingestion, missedCallMessages: notificationScheduled ? { scheduled: true } : { skipped: true, reason: "No unanswered Corner Deli queue leg in this CDR batch." } }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}

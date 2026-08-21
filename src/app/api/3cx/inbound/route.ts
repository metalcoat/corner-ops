import { timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/http";
import { ingestThreeCxCdr, type ThreeCxCdrInput } from "@/lib/three-cx-cdr";
import { notifyClockedInDeliEmployeesOfMissedCalls } from "@/lib/three-cx-missed-call-messages";
import { ingestThreeCxLiveCall, type ThreeCxLiveEvent } from "@/lib/three-cx-live-calls";

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

export async function GET() {
  return Response.json({ ok: true, service: "3CX CDR inbound" });
}

export async function POST(request: Request) {
  try {
    if (!authorized(request)) return Response.json({ error: "Invalid 3CX CDR secret." }, { status: 401 });
    const body = await request.json() as { records?: ThreeCxCdrInput[]; record?: ThreeCxCdrInput; event?:ThreeCxLiveEvent } | ThreeCxCdrInput[];
    if(!Array.isArray(body)&&body.event)return Response.json(await ingestThreeCxLiveCall(body.event),{status:202});
    const records = Array.isArray(body) ? body : Array.isArray(body.records) ? body.records : body.record ? [body.record] : [];
    const ingestion = await ingestThreeCxCdr(records);
    const missedCallMessages = await notifyClockedInDeliEmployeesOfMissedCalls();
    return Response.json({ ...ingestion, missedCallMessages }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}

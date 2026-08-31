import { timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/http";
import { ingestThreeCxLiveCall } from "@/lib/three-cx-live-calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: Request): boolean {
  const expected = process.env.THREE_CX_CRM_SECRET?.trim();
  const supplied = request.headers.get("x-corner-ops-crm-secret")?.trim();
  return Boolean(expected && supplied && equal(expected, supplied));
}

function phone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : "";
}

export async function GET(request: Request) {
  try {
    if (!authorized(request))
      return Response.json({ error: "Invalid 3CX CFD secret." }, { status: 401 });
    const url = new URL(request.url);
    const callerNumber = phone(url.searchParams.get("number") || "");
    const callId = (url.searchParams.get("callId") || "").trim();
    const requestedLine = (url.searchParams.get("line") || "").replace(/\D/g, "");
    const line = requestedLine === "95" || requestedLine === "96" ? requestedLine : undefined;
    if (!callerNumber || !callId)
      return Response.json(
        { error: "A valid caller number and CFD call ID are required." },
        { status: 400 },
      );

    const result = await ingestThreeCxLiveCall({
      callId: `cfd-${callId}`,
      callerNumber,
      queue: process.env.THREE_CX_DELI_QUEUE || "90",
      line,
      status: "ringing",
      startedAt: new Date().toISOString(),
    });
    return Response.json(
      { ...result, queue: process.env.THREE_CX_DELI_QUEUE || "90" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

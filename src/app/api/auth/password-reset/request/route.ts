import { NextRequest, NextResponse } from "next/server";
import { requestAppPasswordReset } from "@/lib/credential-resets";

export const runtime = "nodejs";

function ip(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    await requestAppPasswordReset({ email: String(body.email || ""), requestedIp: ip(request) });
  } catch (error) {
    console.error("[password-reset] request failed", error);
  }
  return NextResponse.json({ requested: true, message: "If that email belongs to an active Corner Ops account, a reset link has been sent." });
}

import { NextRequest, NextResponse } from "next/server";
import { requestEmployeePinReset } from "@/lib/credential-resets";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function business(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Choose Corner Deli or Tiki.");
}

function ip(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    await requestEmployeePinReset({
      email: String(body.email || ""),
      business: business(body.business),
      requestedIp: ip(request),
    });
  } catch (error) {
    console.error("[employee-pin-reset] request failed", error);
  }
  return NextResponse.json({ requested: true, message: "If that email belongs to an active employee at the selected location, a PIN reset link has been sent." });
}

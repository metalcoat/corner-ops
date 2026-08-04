import { NextRequest, NextResponse } from "next/server";
import { completeEmployeePinReset } from "@/lib/credential-resets";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const pin = String(body.pin || "");
    const confirmation = String(body.confirmation || "");
    if (pin !== confirmation) throw new Error("The PIN entries do not match.");
    await completeEmployeePinReset({ token: String(body.token || ""), pin });
    return NextResponse.json({ reset: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "PIN reset failed." }, { status: 400 });
  }
}

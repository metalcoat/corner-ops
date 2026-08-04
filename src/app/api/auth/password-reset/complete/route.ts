import { NextRequest, NextResponse } from "next/server";
import { completeAppPasswordReset } from "@/lib/credential-resets";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const password = String(body.password || "");
    const confirmation = String(body.confirmation || "");
    if (password !== confirmation) throw new Error("The passwords do not match.");
    await completeAppPasswordReset({ token: String(body.token || ""), password });
    return NextResponse.json({ reset: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Password reset failed." }, { status: 400 });
  }
}

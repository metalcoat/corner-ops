import { NextRequest } from "next/server";
import { authenticateDeliPosPin, clearPosSession, getPosSession, setPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";

function attemptKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local-terminal";
}

export async function GET() {
  const session = await getPosSession(false);
  return Response.json({ authenticated: Boolean(session && !session.clockInRequired), session: session?.clockInRequired ? undefined : session });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { pin?: unknown };
    const session = await authenticateDeliPosPin(body.pin, attemptKey(request));
    await setPosSession(session);
    return Response.json({ authenticated: true, session });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "PIN login failed." }, { status: 401 });
  }
}

export async function DELETE() {
  await clearPosSession();
  return Response.json({ authenticated: false });
}

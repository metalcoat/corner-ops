import { isoJson } from "@/lib/timestamp-values";
import { NextRequest } from "next/server";
import { authenticateDeliPosPin, clearPosSession, getPosSession, setPosSession } from "@/lib/pos-auth";
import { pinAttemptKeys } from "@/lib/pos-access-guard";

export const runtime = "nodejs";

export async function GET() {
  const session = await getPosSession(false);
  return isoJson({ authenticated: Boolean(session && !session.clockInRequired), session: session?.clockInRequired ? undefined : session });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { pin?: unknown };
    const session = await authenticateDeliPosPin(body.pin, pinAttemptKeys(request.headers));
    await setPosSession(session);
    return isoJson({ authenticated: true, session });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "PIN login failed." }, { status: 401 });
  }
}

export async function DELETE() {
  await clearPosSession();
  return isoJson({ authenticated: false });
}

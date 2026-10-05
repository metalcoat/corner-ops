import { isoJson } from "@/lib/timestamp-values";
import { clockInDeliPosEmployee, getPosSession, setPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";

export async function POST() {
  try {
    const session = await getPosSession(false);
    if (!session) return isoJson({ error: "POS employee authentication required." }, { status: 401 });
    const result = await clockInDeliPosEmployee(session);
    const ready = { ...session, clockInRequired: false };
    await setPosSession(ready);
    return isoJson({ clockedIn: true, alreadyClockedIn: result.alreadyClockedIn, session: ready });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Clock-in failed." }, { status: 409 });
  }
}

import { apiError, unauthorized } from "@/lib/http";
import { getPosSession } from "@/lib/pos-auth";
import { getPosSettings, savePosIdleLockSeconds } from "@/lib/ordering-pos-settings";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (!await getPosSession(true)) return unauthorized();
    return Response.json({ settings: await getPosSettings("Corner Deli") });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    const actor = await getPosSession(true);
    if (!actor) return unauthorized();
    const body = await request.json() as { posIdleLockSeconds?: unknown; confirmDisabled?: unknown };
    const seconds = Number(body.posIdleLockSeconds);
    if (seconds === 0 && body.confirmDisabled !== true) return Response.json({ error: "Confirm that automatic POS locking will be disabled." }, { status: 409 });
    return Response.json({ settings: await savePosIdleLockSeconds("Corner Deli", seconds, actor.employeeId) });
  } catch (error) { return apiError(error); }
}

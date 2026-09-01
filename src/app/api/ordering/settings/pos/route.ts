import { apiError } from "@/lib/http";
import { isAuthorizationResponse, orderingManagerActor } from "@/lib/ordering-route-auth";
import { getPosSettings, savePosSettings } from "@/lib/ordering-pos-settings";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await orderingManagerActor("Corner Deli");
    if (isAuthorizationResponse(actor)) return actor;
    return Response.json({ settings: await getPosSettings("Corner Deli") });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    const actor = await orderingManagerActor("Corner Deli");
    if (isAuthorizationResponse(actor)) return actor;
    const body = await request.json() as { posIdleLockSeconds?: unknown; confirmDisabled?: unknown; onlineOrderAlertSound?: unknown; onlineOrderAlertVolume?: unknown };
    const seconds = Number(body.posIdleLockSeconds);
    if (seconds === 0 && body.confirmDisabled !== true) return Response.json({ error: "Confirm that automatic POS locking will be disabled." }, { status: 409 });
    return Response.json({ settings: await savePosSettings("Corner Deli", seconds, body.onlineOrderAlertSound, body.onlineOrderAlertVolume, actor.id) });
  } catch (error) { return apiError(error); }
}

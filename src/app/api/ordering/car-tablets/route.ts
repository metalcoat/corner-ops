import { apiError, ValidationError } from "@/lib/http";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { isoJson } from "@/lib/timestamp-values";
import { formatPairingCode, snapCameras } from "@/lib/car-tablet-rules";
import { createPairing, listPhotos, listTablets, queueSnap, renameTablet, revokeTablet } from "@/lib/car-tablet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUSINESS = "Corner Deli";

/** POS: the car tablets (online, battery, GPS, driver) and their latest photos. Any signed-in POS employee. */
export async function GET() {
  try {
    const actor = await orderingActor(BUSINESS);
    if (!actor) return isoJson({ error: "POS sign-in required." }, { status: 401 });
    const [tablets, photos] = await Promise.all([listTablets(BUSINESS), listPhotos(BUSINESS, { limit: 24 })]);
    return isoJson({ tablets, photos, manager: canManagePos(actor) });
  } catch (error) {
    return apiError(error);
  }
}

/** Manager actions: pair (new or again), rename, unpair, snap now. */
export async function POST(request: Request) {
  try {
    const actor = await orderingActor(BUSINESS);
    if (!actor) return isoJson({ error: "POS sign-in required." }, { status: 401 });
    if (!canManagePos(actor)) return isoJson({ error: "Manager access required." }, { status: 403 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const tabletId = body.tabletId ? String(body.tabletId) : undefined;
    switch (body.action) {
      case "pair": {
        const pairing = await createPairing({ business: BUSINESS, name: String(body.name || ""), tabletId, createdBy: actor.name });
        return isoJson({ ...pairing, code: formatPairingCode(pairing.code) });
      }
      case "rename":
        return isoJson(await renameTablet(BUSINESS, String(tabletId), String(body.name || "")));
      case "revoke":
        return isoJson(await revokeTablet(BUSINESS, String(tabletId)));
      case "snap":
        return isoJson(await queueSnap(BUSINESS, String(tabletId), snapCameras(body.camera), actor.name, body.orderId ? String(body.orderId) : null));
      default:
        throw new ValidationError("Unknown car tablet action.");
    }
  } catch (error) {
    return apiError(error);
  }
}

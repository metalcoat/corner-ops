import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { markCurbsideDelivered, posCurbsideArrivals } from "@/lib/curbside-arrivals";

export const runtime = "nodejs";

/** Curbside customers waiting outside, for the POS banner and the order screen. */
export async function GET() {
  try {
    if (!(await orderingActor("Corner Deli"))) return unauthorized();
    return isoJson({ arrivals: await posCurbsideArrivals("Corner Deli") }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

/** { arrivalId }: staff brought the order out to the car. Stops the store PC's curbside popup and bell. */
export async function POST(request: Request) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const body = (await request.json().catch(() => ({}))) as { arrivalId?: unknown };
    const arrivalId = Number(body.arrivalId);
    if (!Number.isSafeInteger(arrivalId) || arrivalId <= 0) return isoJson({ error: "Choose the curbside customer." }, { status: 400 });
    if (!(await markCurbsideDelivered(arrivalId, "Corner Deli", actor)))
      return isoJson({ error: "That customer was already marked delivered." }, { status: 409 });
    return isoJson({ delivered: true });
  } catch (error) {
    return apiError(error);
  }
}

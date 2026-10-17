import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { markDoorChimeEvents } from "@/lib/door-chime";
import { parseDoorGreet } from "@/lib/door-chime-policy";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

// Under /api/ordering/orders so the proxy's Deli POS API policy already covers it.
// Body: { "ids": [12, 13], "outcome": "greeted" | "not_customer" }
export async function POST(request: Request) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const { ids, outcome } = parseDoorGreet(await request.json().catch(() => ({})));
    const marked = await markDoorChimeEvents("Corner Deli", ids, outcome, { id: actor.id, name: actor.name });
    return isoJson({ marked });
  } catch (error) {
    return apiError(error);
  }
}

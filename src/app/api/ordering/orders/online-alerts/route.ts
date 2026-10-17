import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { listWaitingOnlineOrders } from "@/lib/ordering-online-alerts";
import { listRecentDoorChimeEvents } from "@/lib/door-chime";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

// Lives under /api/ordering/orders so the proxy's existing Deli POS API policy
// already covers it (a /api/ordering/kitchen/* sub-path would be rejected).
export async function GET(request: Request) {
  try {
    const value = new URL(request.url).searchParams.get("business");
    if (value !== "Corner Deli" && value !== "Tiki") throw new Error("Unknown business.");
    const business: OrderingBusiness = value;
    if (!await orderingActor(business)) return unauthorized();
    // Door chime walk-ins ride along on the same poll so screens don't add a second request;
    // a door problem must never stop online-order alerts.
    const [orders, doorEvents] = await Promise.all([listWaitingOnlineOrders(business), listRecentDoorChimeEvents(business).catch(() => [])]);
    return isoJson({ business, orders, doorEvents });
  } catch (error) {
    return apiError(error);
  }
}

import { ValidationError } from "@/lib/http";
import { withTablet } from "@/lib/car-tablet-route";
import { tabletDriveRoute } from "@/lib/car-tablet";

export const runtime = "nodejs";

/**
 * Turn-by-turn route for the tablet's Drive screen: from where the car is to a delivery (its Belmont
 * Courts building when there is one), on preferred streets, never down an avoid street except the last
 * stretch to a house on it. The tablet asks again when the driver leaves the route.
 */
export function POST(request: Request) {
  return withTablet(request, async (tablet) => {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const from = body.from as { latitude?: unknown; longitude?: unknown } | undefined;
    const latitude = Number(from?.latitude), longitude = Number(from?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new ValidationError("Send where the car is (from.latitude, from.longitude).");
    return tabletDriveRoute(tablet, { latitude, longitude }, String(body.deliveryId || ""));
  });
}

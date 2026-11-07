import { randomUUID } from "node:crypto";
import { apiError, ValidationError } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { isoJson } from "@/lib/timestamp-values";
import { validateDeliveryAddress } from "@/lib/ordering-address";
import { deliLocation } from "@/lib/deli-location";
import { complexBuilding } from "@/lib/complex-buildings";
import { ogdensburgRouter } from "@/lib/route-map/ogdensburg-router";

export const runtime = "nodejs";

type Place = { latitude: number; longitude: number; label: string };

async function place(text: string, unit = ""): Promise<Place> {
  const address = await validateDeliveryAddress({ enteredAddress: text, sessionToken: randomUUID() });
  const building = complexBuilding({ address: address.formattedAddress, unit, latitude: address.latitude, longitude: address.longitude });
  return building
    ? { latitude: building.latitude, longitude: building.longitude, label: `${address.formattedAddress} · ${building.label}` }
    : { latitude: address.latitude, longitude: address.longitude, label: address.formattedAddress };
}

/**
 * Route tester (POS Settings › Route tester): the route and turn-by-turn directions the car tablet would
 * give from the deli (or any address) to an address, with the owner's street rules.
 */
export async function POST(request: Request) {
  try {
    if (!(await orderingActor("Corner Deli"))) return isoJson({ error: "POS sign-in required." }, { status: 401 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const toText = String(body.to || "").trim();
    if (toText.length < 5) throw new ValidationError("Enter the address to drive to.");
    const fromText = String(body.from || "").trim();
    const deli = await deliLocation();
    const from: Place | null = fromText ? await place(fromText) : deli ? { ...deli, label: "Corner Deli" } : null;
    if (!from) throw new ValidationError("The deli's location isn't set; enter a starting address.");
    const to = await place(toText, String(body.unit || ""));
    const router = ogdensburgRouter();
    if (router.distanceToNetwork(from) > 800 || router.distanceToNetwork(to) > 800)
      return isoJson({ from, to, route: null, reason: "That address is outside the Ogdensburg street map; the tablet would open Google Maps." });
    const leg = router.route(from, to);
    if (!leg) return isoJson({ from, to, route: null, reason: "No street route found." });
    return isoJson({
      from, to,
      route: {
        path: leg.path, steps: leg.steps, seconds: Math.round(leg.seconds), metres: Math.round(leg.metres), stopSigns: leg.stopSigns,
        preferredMetres: Math.round(leg.preferredMetres), avoidMetres: Math.round(leg.avoidMetres), streets: leg.streets,
      },
    });
  } catch (error) {
    if (error instanceof Error && /address|street/i.test(error.message) && !(error instanceof ValidationError)) return isoJson({ error: error.message }, { status: 400 });
    return apiError(error);
  }
}

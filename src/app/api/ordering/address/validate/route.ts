import { createAddressValidationToken, routeDeliveryAddress, validateDeliveryAddress } from "@/lib/ordering-address";
import { apiError, unauthorized } from "@/lib/http";
import { getPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = await getPosSession(true);
    if (!session || session.business !== "Corner Deli") return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const sessionToken = String(body.sessionToken || "");
    if (!/^[a-zA-Z0-9-]{20,80}$/.test(sessionToken)) return Response.json({ error: "A valid address session is required." }, { status: 400 });
    const address = await validateDeliveryAddress({ enteredAddress: String(body.enteredAddress || ""), placeId: body.placeId ? String(body.placeId) : undefined, sessionToken });
    let route = null;
    try { route = await routeDeliveryAddress(address); } catch { /* Origin coordinates are optional in this milestone. */ }
    return Response.json({ address, validationToken: createAddressValidationToken(address), route });
  } catch (error) {
    if (error instanceof Error && (/^(Delivery address validation is unavailable|Enter a complete street address|This address is incomplete or ambiguous)/.test(error.message))) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}

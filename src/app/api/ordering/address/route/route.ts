import { readAddressValidationToken, routeDeliveryAddress } from "@/lib/ordering-address";
import { apiError, unauthorized } from "@/lib/http";
import { getPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const session = await getPosSession(true);
    if (!session || session.business !== "Corner Deli") return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const address = readAddressValidationToken(String(body.validationToken || ""), String(body.enteredAddress || ""));
    if (!address) return Response.json({ error: "Revalidate the delivery address before calculating a route." }, { status: 409 });
    return Response.json({ route: await routeDeliveryAddress(address) });
  } catch (error) { return apiError(error); }
}

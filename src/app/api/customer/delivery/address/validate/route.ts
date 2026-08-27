import {
  createAddressValidationToken,
  routeDeliveryAddress,
  validateDeliveryAddress,
} from "@/lib/ordering-address";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const sessionToken = String(body.sessionToken || "");
    if (!/^[a-zA-Z0-9-]{20,80}$/.test(sessionToken))
      return Response.json(
        { error: "A valid address session is required." },
        { status: 400 },
      );
    const address = await validateDeliveryAddress({
      enteredAddress: String(body.enteredAddress || ""),
      placeId: body.placeId ? String(body.placeId) : undefined,
      sessionToken,
    });
    const route = await routeDeliveryAddress(address);
    return Response.json({
      address,
      route,
      validationToken: createAddressValidationToken(address),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Address validation failed.",
      },
      { status: 409 },
    );
  }
}

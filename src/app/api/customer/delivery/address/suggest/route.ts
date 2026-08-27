import {
  normalizeAddressInput,
  suggestDeliveryAddresses,
} from "@/lib/ordering-address";

export const runtime = "nodejs";
const requests = new Map<string, number[]>();

export async function POST(request: Request) {
  try {
    const key =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const now = Date.now();
    const recent = (requests.get(key) || []).filter(
      (time) => now - time < 60_000,
    );
    if (recent.length >= 30)
      return Response.json(
        { error: "Address lookup is temporarily rate limited." },
        { status: 429 },
      );
    recent.push(now);
    requests.set(key, recent);
    const body = (await request.json()) as Record<string, unknown>;
    const input = normalizeAddressInput(body.input);
    const sessionToken = String(body.sessionToken || "");
    if (!/^[a-zA-Z0-9-]{20,80}$/.test(sessionToken))
      return Response.json(
        { error: "A valid address session is required." },
        { status: 400 },
      );
    return Response.json({
      suggestions:
        input.length < 2
          ? []
          : await suggestDeliveryAddresses(input, sessionToken),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Address lookup failed.",
      },
      { status: 503 },
    );
  }
}

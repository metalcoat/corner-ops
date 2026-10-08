import { isoJson } from "@/lib/timestamp-values";
import { normalizeAddressInput, suggestDeliveryAddresses } from "@/lib/ordering-address";
import { apiError, unauthorized } from "@/lib/http";
import { getPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";
const requestTimes = new Map<string, number[]>();

function permitted(employeeId: string): boolean {
  const now = Date.now();
  const recent = (requestTimes.get(employeeId) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 60) return false;
  recent.push(now); requestTimes.set(employeeId, recent); return true;
}

export async function POST(request: Request) {
  try {
    const session = await getPosSession(true);
    if (!session || session.business !== "Corner Deli") return unauthorized();
    if (!permitted(session.employeeId)) return isoJson({ error: "Address lookup is temporarily rate limited." }, { status: 429 });
    const body = await request.json() as Record<string, unknown>;
    const input = normalizeAddressInput(body.input);
    if (input.length < 2) return isoJson({ suggestions: [] });
    const token = String(body.sessionToken || "");
    if (!/^[a-zA-Z0-9-]{20,80}$/.test(token)) return isoJson({ error: "A valid address session is required." }, { status: 400 });
    return isoJson({ suggestions: await suggestDeliveryAddresses(input, token) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Delivery address validation is unavailable")) return isoJson({ error: error.message }, { status: 503 });
    return apiError(error);
  }
}

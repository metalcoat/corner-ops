import { apiError } from "@/lib/http";
import { assertRateLimit, authRatePolicies, clearRateLimit, recordRateLimitFailure } from "@/lib/rate-limit";
import { isoJson } from "@/lib/timestamp-values";
import { completePairing } from "@/lib/car-tablet";

export const runtime = "nodejs";

/** The tablet's pairing screen: the code shown in POS Settings › Car tablet → a long-lived token. */
export async function POST(request: Request) {
  const policies = authRatePolicies("car-tablet-pair", request, "car-tablets");
  try {
    await assertRateLimit(policies);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const paired = await completePairing(body.code, { appVersion: String(body.appVersion || ""), model: String(body.model || "") });
      await clearRateLimit(policies);
      return isoJson(paired);
    } catch (error) {
      await recordRateLimitFailure(policies);
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}

import { createDeliBoardToken } from "@/lib/deli-board-auth";
import { apiError, RateLimitError } from "@/lib/http";
import { assertRateLimit, authRatePolicies, clearRateLimit, recordRateLimitFailure, type RateLimitPolicy } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let policies: RateLimitPolicy[] = [];
  try {
    const body = await request.json() as Record<string, unknown>;
    policies = authRatePolicies("deli-board-login", request, "Corner Deli");
    await assertRateLimit(policies);
    const { token, payload } = await createDeliBoardToken(String(body.pin || ""));
    await clearRateLimit(policies);
    return Response.json({
      authenticated: true,
      token,
      expiresAt: payload.expiresAt,
      employeeName: payload.employeeName,
    });
  } catch (error) {
    if (policies.length && !(error instanceof RateLimitError)) {
      await recordRateLimitFailure(policies).catch((failure) => console.error("[deli-board/login] rate-limit record failed", failure));
    }
    return apiError(error);
  }
}

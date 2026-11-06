import { apiError, RateLimitError } from "@/lib/http";
import { completeOnboardingAccount, onboardingWelcome, signInFromOnboardingLink } from "@/lib/employee-onboarding";
import { assertRateLimit, authRatePolicies, clearRateLimit, recordRateLimitFailure, type RateLimitPolicy } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** The new hire's setup link. The token in the link is the only credential until they choose a PIN. */
export async function GET(request: Request) {
  try {
    const result = await onboardingWelcome(new URL(request.url).searchParams.get("token"));
    return Response.json(result, { status: result.valid ? 200 : 410 });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let policies: RateLimitPolicy[] = [];
  try {
    const body = await request.json() as Record<string, unknown>;
    policies = authRatePolicies("employee-onboarding", request, "onboarding");
    await assertRateLimit(policies);
    const userAgent = request.headers.get("user-agent") || "";
    const action = String(body.action || "");
    const result = action === "set-pin"
      ? await completeOnboardingAccount({ token: body.token, pin: body.pin, pinConfirm: body.pinConfirm, userAgent })
      : action === "sign-in"
        ? await signInFromOnboardingLink({ token: body.token, pin: body.pin, userAgent })
        : null;
    if (!result) return Response.json({ error: "Unknown action." }, { status: 400 });
    await clearRateLimit(policies);
    return Response.json(result);
  } catch (error) {
    if (policies.length && !(error instanceof RateLimitError)) {
      await recordRateLimitFailure(policies).catch((failure) => console.error("[employee/onboarding] rate-limit record failed", failure));
    }
    return apiError(error);
  }
}

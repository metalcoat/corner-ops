import { clearEmployeeSession, createEmployeeSession, getEmployeeSession } from "@/lib/employee-auth";
import { apiError, RateLimitError } from "@/lib/http";
import { assertRateLimit, authRatePolicies, clearRateLimit, recordRateLimitFailure, type RateLimitPolicy } from "@/lib/rate-limit";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Choose Corner Deli or Tiki.");
}

export async function GET() {
  const session = await getEmployeeSession();
  return Response.json({ authenticated: Boolean(session), session });
}

export async function POST(request: Request) {
  let policies: RateLimitPolicy[] = [];
  try {
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    policies = authRatePolicies("employee-session", request, business);
    await assertRateLimit(policies);
    const session = await createEmployeeSession(business, String(body.pin || ""));
    await clearRateLimit(policies);
    return Response.json({ authenticated: true, session });
  } catch (error) {
    if (policies.length && !(error instanceof RateLimitError)) {
      await recordRateLimitFailure(policies).catch((failure) => console.error("[employee/session] rate-limit record failed", failure));
    }
    return apiError(error);
  }
}

export async function DELETE() {
  await clearEmployeeSession();
  return Response.json({ authenticated: false });
}

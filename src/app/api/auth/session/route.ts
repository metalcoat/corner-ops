import { clearSession, createSession, getSession } from "@/lib/auth";
import { ConfigurationError, getMissingConfiguration } from "@/lib/config";
import { apiError, RateLimitError } from "@/lib/http";
import { assertRateLimit, clearRateLimit, clientIp, recordRateLimitFailure, type RateLimitPolicy } from "@/lib/rate-limit";
import { authenticateAppUser } from "@/lib/users";

export async function GET() {
  const missing = getMissingConfiguration();
  const session = await getSession();
  return Response.json({
    authenticated: Boolean(session),
    configured: missing.length === 0,
    missing,
    email: session?.email,
    displayName: session?.displayName,
    role: session?.role,
    businesses: session?.businesses,
    permissions: session?.permissions,
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    // Password guessing limits: per visitor IP (Cloudflare's address) and per account.
    const account = String(body.email || "").trim().toLowerCase().slice(0, 320) || "(default)";
    const policies: RateLimitPolicy[] = [
      { scope: "owner-login", discriminator: `ip:${clientIp(request)}`, maxFailures: 10, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
      { scope: "owner-login", discriminator: `account:${account}`, maxFailures: 10, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
    ];
    await assertRateLimit(policies);
    const identity = await authenticateAppUser(body.email, body.password);
    if (!identity) {
      await recordRateLimitFailure(policies);
      return Response.json({ error: "Incorrect email or password." }, { status: 401 });
    }
    await clearRateLimit(policies);
    const session = await createSession(identity);
    return Response.json({
      authenticated: true,
      email: session.email,
      displayName: session.displayName,
      role: session.role,
      businesses: session.businesses,
      permissions: session.permissions,
    });
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof RateLimitError) return apiError(error);
    return Response.json({ error: error instanceof Error ? error.message : "Invalid login request." }, { status: 400 });
  }
}

export async function DELETE() {
  await clearSession();
  return new Response(null, { status: 204 });
}

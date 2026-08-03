import { clearSession, createSession, getSession } from "@/lib/auth";
import { ConfigurationError, getMissingConfiguration } from "@/lib/config";
import { apiError } from "@/lib/http";
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
    const identity = await authenticateAppUser(body.email, body.password);
    if (!identity) return Response.json({ error: "Incorrect email or password." }, { status: 401 });
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
    if (error instanceof ConfigurationError) return apiError(error);
    return Response.json({ error: error instanceof Error ? error.message : "Invalid login request." }, { status: 400 });
  }
}

export async function DELETE() {
  await clearSession();
  return new Response(null, { status: 204 });
}

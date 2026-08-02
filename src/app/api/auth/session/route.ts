import { clearSession, createSession, getSession, isValidPassword } from "@/lib/auth";
import { ConfigurationError, getMissingConfiguration } from "@/lib/config";
import { apiError } from "@/lib/http";

export async function GET() {
  const missing = getMissingConfiguration();
  const session = await getSession();
  return Response.json({
    authenticated: Boolean(session),
    configured: missing.length === 0,
    missing,
    email: session?.email,
    businesses: session?.businesses,
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!isValidPassword(password)) {
      return Response.json({ error: "Incorrect password." }, { status: 401 });
    }
    const session = await createSession();
    return Response.json({ authenticated: true, email: session.email, businesses: session.businesses });
  } catch (error) {
    if (error instanceof ConfigurationError) return apiError(error);
    return Response.json({ error: "Invalid login request." }, { status: 400 });
  }
}

export async function DELETE() {
  await clearSession();
  return new Response(null, { status: 204 });
}

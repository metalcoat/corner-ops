import { customerSessionCookie } from "@/lib/customer-ordering-session";
import {
  linkGoogleCustomer,
  verifyGoogleState,
} from "@/lib/customer-google-auth";
export const runtime = "nodejs";
function publicOrigin(request: Request) {
  return (
    process.env.CUSTOMER_APP_URL?.trim() || new URL(request.url).origin
  ).replace(/\/$/, "");
}
function cookie(request: Request, name: string) {
  return (
    (request.headers.get("cookie") || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ""
  );
}
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      state = url.searchParams.get("state") || "",
      code = url.searchParams.get("code") || "";
    if (
      !code ||
      state !== cookie(request, "corner_google_state") ||
      !verifyGoogleState(state)
    )
      throw new Error("Google sign-in expired. Please try again.");
    const redirect = new URL(
      "/api/customer/auth/google/callback",
      publicOrigin(request),
    ).toString();
    const token = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        redirect_uri: redirect,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await token.json();
    if (!token.ok || !tokens.access_token)
      throw new Error("Google sign-in could not be completed.");
    const profileResponse = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    const profile = await profileResponse.json();
    if (!profileResponse.ok)
      throw new Error("Google profile could not be verified.");
    const customerId = await linkGoogleCustomer(profile);
    const response = Response.redirect(
      new URL("/account", publicOrigin(request)),
    );
    response.headers.append(
      "Set-Cookie",
      customerSessionCookie({
        sessionId: crypto.randomUUID(),
        customerId,
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 30 * 86400000,
      }),
    );
    response.headers.append(
      "Set-Cookie",
      "corner_google_state=; Path=/api/customer/auth/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
    return response;
  } catch (error) {
    return Response.redirect(
      new URL(
        `/account/sign-in?error=${encodeURIComponent(error instanceof Error ? error.message : "Sign-in failed.")}`,
        publicOrigin(request),
      ),
    );
  }
}

import { googleState } from "@/lib/customer-google-auth";
export const runtime = "nodejs";
function publicOrigin(request: Request) {
  return (
    process.env.CUSTOMER_APP_URL?.trim() || new URL(request.url).origin
  ).replace(/\/$/, "");
}
export async function GET(request: Request) {
  const client = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!client)
    return Response.redirect(
      new URL(
        "/account/sign-in?error=Google+sign-in+is+not+configured",
        publicOrigin(request),
      ),
    );
  const state = googleState(),
    redirect = new URL(
      "/api/customer/auth/google/callback",
      publicOrigin(request),
    ).toString(),
    url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `corner_google_state=${state}; Path=/api/customer/auth/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

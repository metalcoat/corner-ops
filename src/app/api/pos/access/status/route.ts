import { ipAllowed, networkCookie, POS_NETWORK_COOKIE, requestIp } from "@/lib/pos-network-access";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const ip = requestIp(request.headers), allowed = Boolean(ip) && await ipAllowed(ip);
  const enter = new URL(request.url).searchParams.get("enter") === "1";
  if (allowed && enter) {
    const response = Response.redirect(new URL("/pos/deli", request.url), 303);
    response.headers.append("Set-Cookie", `${POS_NETWORK_COOKIE}=${networkCookie(ip)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    return response;
  }
  const response = Response.json({ allowed, ip });
  if (allowed) response.headers.append("Set-Cookie", `${POS_NETWORK_COOKIE}=${networkCookie(ip)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  return response;
}

import { ipAllowed, networkCookie, POS_NETWORK_COOKIE, requestIp } from "@/lib/pos-network-access";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const ip = requestIp(request.headers), allowed = Boolean(ip) && await ipAllowed(ip);
  const response = Response.json({ allowed, ip });
  if (allowed) response.headers.append("Set-Cookie", `${POS_NETWORK_COOKIE}=${networkCookie(ip)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  return response;
}

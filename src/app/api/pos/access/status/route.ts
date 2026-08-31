import { ipAllowed, networkCookie, POS_NETWORK_COOKIE, requestIp } from "@/lib/pos-network-access";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const ip = requestIp(request.headers), allowed = Boolean(ip) && await ipAllowed(ip);
  const enter = new URL(request.url).searchParams.get("enter") === "1";
  if (allowed && enter) {
    const forwardedHost=request.headers.get("x-forwarded-host")||request.headers.get("host")||"",forwardedProto=request.headers.get("x-forwarded-proto")||"https";
    const location=forwardedHost&&!/^(localhost|127\.)/.test(forwardedHost)?`https://${forwardedHost}/pos/deli`:`${forwardedProto}://${forwardedHost}/pos/deli`;
    return new Response(null, { status: 303, headers: {
      Location: location,
      "Set-Cookie": `${POS_NETWORK_COOKIE}=${networkCookie(ip)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    } });
  }
  const response = Response.json({ allowed, ip });
  if (allowed) response.headers.append("Set-Cookie", `${POS_NETWORK_COOKIE}=${networkCookie(ip)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  return response;
}

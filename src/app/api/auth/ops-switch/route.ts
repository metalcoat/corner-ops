import { createHash, randomBytes } from "node:crypto";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { businessForOpsHost, opsHostForBusiness, safeOpsReturnPath } from "@/lib/ops-host-switch";
import type { Business } from "@/lib/types";

export async function POST(request: Request) {
  const sourceHost = request.headers.get("host")?.split(":")[0].toLowerCase() || "";
  if (!businessForOpsHost(sourceHost)) return new Response(null, { status: 404 });
  const session = await getSession();
  if (!session?.userId) return Response.json({ error: "Sign in again to switch businesses." }, { status: 401 });
  const body = await request.json().catch(() => null) as { business?: unknown; returnTo?: unknown } | null;
  const business = body?.business;
  if (business !== "Corner Deli" && business !== "Tiki") return Response.json({ error: "Choose a valid business." }, { status: 400 });
  if (!canAccessBusiness(session, business)) return Response.json({ error: "Your account cannot access that business." }, { status: 403 });
  const targetHost = opsHostForBusiness(business as Business);
  if (targetHost === sourceHost) return Response.json({ error: "Already on that business site." }, { status: 400 });
  const code = randomBytes(32).toString("base64url");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const sql = getSql();
  await sql`DELETE FROM public.ops_host_switches WHERE expires_at < now()`;
  await sql`
    INSERT INTO public.ops_host_switches (code_hash, user_id, session_version, target_host, expires_at)
    VALUES (${codeHash}, ${session.userId}, ${session.sessionVersion || 1}, ${targetHost}, now() + interval '60 seconds')
  `;
  return Response.json({
    target: `https://${targetHost}/api/auth/ops-switch/complete`,
    code,
    returnTo: safeOpsReturnPath(body?.returnTo),
  }, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

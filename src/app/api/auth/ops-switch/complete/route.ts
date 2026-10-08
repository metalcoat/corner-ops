import { createHash } from "node:crypto";
import { createSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { businessForOpsHost, safeOpsReturnPath } from "@/lib/ops-host-switch";
import { permissionsForRole, type AppRole } from "@/lib/users";
import type { Business } from "@/lib/types";

export async function POST(request: Request) {
  const targetHost = request.headers.get("host")?.split(":")[0].toLowerCase() || "";
  const business = businessForOpsHost(targetHost);
  if (!business) return new Response(null, { status: 404 });
  const form = await request.formData().catch(() => null);
  const code = form?.get("code");
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return new Response("Invalid switch code.", { status: 400 });
  const codeHash = createHash("sha256").update(code).digest("hex");
  const sql = getSql();
  const used = await sql`
    DELETE FROM public.ops_host_switches
    WHERE code_hash = ${codeHash} AND target_host = ${targetHost} AND expires_at > now()
    RETURNING user_id, session_version
  ` as unknown as Array<{ user_id: string; session_version: number }>;
  if (!used[0]) return new Response("Switch link expired. Return to the original site and try again.", { status: 401 });
  const rows = await sql`
    SELECT id, email, display_name, role, businesses, session_version
    FROM public.app_users WHERE id = ${used[0].user_id} AND active = true LIMIT 1
  ` as unknown as Array<{ id: string; email: string; display_name: string; role: AppRole; businesses: Business[] | string; session_version: number }>;
  const user = rows[0];
  if (!user || Number(user.session_version || 1) !== Number(used[0].session_version)) return new Response("Account access has changed. Please sign in again.", { status: 401 });
  const values = Array.isArray(user.businesses) ? user.businesses : String(user.businesses || "").replace(/[{}]/g, "").split(",");
  const allowed = values.filter((value): value is Business => value === "Corner Deli" || value === "Tiki");
  if (!allowed.includes(business)) return new Response("This account cannot access that business.", { status: 403 });
  await createSession({ id: user.id, email: user.email, displayName: user.display_name, role: user.role,
    businesses: allowed, permissions: permissionsForRole(user.role), sessionVersion: Number(user.session_version || 1) });
  const returnTo = safeOpsReturnPath(form?.get("returnTo"));
  return Response.redirect(new URL(returnTo, `https://${targetHost}`), 303);
}

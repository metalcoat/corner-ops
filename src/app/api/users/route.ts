import { getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { appRoles, listAppUsers, saveAppUser, setUserActive } from "@/lib/users";
import type { AppRole } from "@/lib/users";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "users.manage");
    return Response.json({ users: await listAppUsers(), roles: appRoles });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "users.manage");
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "save");
    if (action === "active") return Response.json(await setUserActive(String(body.id || ""), Boolean(body.active)));
    const role = String(body.role || "Viewer") as AppRole;
    const businesses = (Array.isArray(body.businesses) ? body.businesses : [])
      .filter((value): value is Business => value === "Corner Deli" || value === "Tiki");
    return Response.json(await saveAppUser({
      id: body.id ? String(body.id) : undefined,
      email: String(body.email || ""), displayName: String(body.displayName || ""), role, businesses,
      password: body.password ? String(body.password) : undefined, active: body.active === undefined ? true : Boolean(body.active), actor: session.email,
    }), { status: body.id ? 200 : 201 });
  } catch (error) {
    return apiError(error);
  }
}

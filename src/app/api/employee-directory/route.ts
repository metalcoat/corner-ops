import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  createDirectoryEmployee,
  listDirectoryEmployees,
  updateDirectoryEmployee,
} from "@/lib/employee-directory-admin";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = businessFrom(new URL(request.url).searchParams.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json({ employees: await listDirectoryEmployees(business) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const action = String(body.action || "create");
    if (action === "create") {
      const roleGroup = String(body.roleGroup || "In-House");
      if (roleGroup !== "Driver" && roleGroup !== "In-House" && roleGroup !== "Ignore") {
        throw new Error("Invalid employee role group.");
      }
      return Response.json(await createDirectoryEmployee({
        business,
        email: body.email ? String(body.email) : "",
        name: String(body.name || ""),
        pin: String(body.pin || ""),
        position: String(body.position || ""),
        roleGroup,
        countsForTips: body.countsForTips !== false,
        hourlyRate: Number(body.hourlyRate || 0),
        tippedRate: Number(body.tippedRate || 0),
      }), { status: 201 });
    }

    if (action === "update-access") {
      return Response.json(await updateDirectoryEmployee({
        id: String(body.id || ""),
        business,
        email: body.email === undefined ? undefined : String(body.email || ""),
        pin: body.pin ? String(body.pin) : undefined,
        active: body.active === undefined ? undefined : body.active === true,
      }));
    }

    return Response.json({ error: "Unknown employee directory action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

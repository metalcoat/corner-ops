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

function roleGroupFrom(value: unknown): "Driver" | "In-House" | "Ignore" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "Driver" || value === "In-House" || value === "Ignore") return value;
  throw new Error("Invalid employee role group.");
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
      return Response.json(await createDirectoryEmployee({
        business,
        email: body.email ? String(body.email) : "",
        name: String(body.name || ""),
        pin: String(body.pin || ""),
        position: String(body.position || ""),
        roleGroup: roleGroupFrom(body.roleGroup) || "In-House",
        countsForTips: body.countsForTips !== false,
        hourlyRate: Number(body.hourlyRate || 0),
        tippedRate: Number(body.tippedRate || 0),
      }), { status: 201 });
    }

    if (action === "update-access" || action === "update-profile") {
      return Response.json(await updateDirectoryEmployee({
        id: String(body.id || ""),
        business,
        email: body.email === undefined ? undefined : String(body.email || ""),
        pin: body.pin ? String(body.pin) : undefined,
        active: body.active === undefined ? undefined : body.active === true,
        name: body.name === undefined ? undefined : String(body.name || ""),
        position: body.position === undefined ? undefined : String(body.position || ""),
        roleGroup: roleGroupFrom(body.roleGroup),
        countsForTips: body.countsForTips === undefined ? undefined : body.countsForTips === true,
        hourlyRate: body.hourlyRate === undefined ? undefined : Number(body.hourlyRate || 0),
        tippedRate: body.tippedRate === undefined ? undefined : Number(body.tippedRate || 0),
      }));
    }

    return Response.json({ error: "Unknown employee directory action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

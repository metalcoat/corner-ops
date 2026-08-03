import { canAccessBusiness, getSession } from "@/lib/auth";
import { attendanceAdminDashboard, reviewAttendanceCase } from "@/lib/attendance";
import { apiError, unauthorized } from "@/lib/http";
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
    return Response.json(await attendanceAdminDashboard(business));
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
    if (String(body.action || "") !== "review") {
      return Response.json({ error: "Unknown attendance action." }, { status: 400 });
    }
    return Response.json(await reviewAttendanceCase({
      id: String(body.id || ""),
      business,
      approve: body.approve === true,
      actor: session.displayName,
      managerNote: body.managerNote ? String(body.managerNote) : "",
    }));
  } catch (error) {
    return apiError(error);
  }
}

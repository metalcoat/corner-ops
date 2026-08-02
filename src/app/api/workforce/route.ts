import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";
import {
  copyScheduleWeek,
  createScheduleShift,
  reviewShiftRequest,
  reviewTimeCorrection,
  reviewTimeOff,
  sendOwnerMessage,
  updateScheduleShift,
  workforceDashboard,
} from "@/lib/workforce";

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
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json(await workforceDashboard(business));
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
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const action = String(body.action || "");

    if (action === "shift-create") {
      const status = String(body.status || "Draft");
      if (status !== "Draft" && status !== "Published" && status !== "Open") throw new Error("Invalid shift status.");
      return Response.json(await createScheduleShift({
        business,
        employeeId: body.employeeId ? String(body.employeeId) : null,
        position: String(body.position || ""),
        startsAt: String(body.startsAt || ""),
        endsAt: String(body.endsAt || ""),
        status,
        notes: body.notes ? String(body.notes) : "",
        actor: session.email,
      }), { status: 201 });
    }

    if (action === "shift-update") {
      const status = body.status ? String(body.status) : undefined;
      if (status && status !== "Draft" && status !== "Published" && status !== "Open" && status !== "Cancelled") {
        throw new Error("Invalid shift status.");
      }
      return Response.json(await updateScheduleShift({
        id: String(body.id || ""),
        business,
        employeeId: body.employeeId === undefined ? undefined : body.employeeId ? String(body.employeeId) : null,
        position: body.position === undefined ? undefined : String(body.position || ""),
        startsAt: body.startsAt === undefined ? undefined : String(body.startsAt || ""),
        endsAt: body.endsAt === undefined ? undefined : String(body.endsAt || ""),
        status: status as "Draft" | "Published" | "Open" | "Cancelled" | undefined,
        notes: body.notes === undefined ? undefined : String(body.notes || ""),
      }));
    }

    if (action === "week-copy") {
      return Response.json(await copyScheduleWeek({
        business,
        sourceWeekStart: String(body.sourceWeekStart || ""),
        actor: session.email,
      }));
    }

    if (action === "message-send") {
      return Response.json(await sendOwnerMessage({
        business,
        recipientEmployeeId: body.recipientEmployeeId ? String(body.recipientEmployeeId) : null,
        body: String(body.body || ""),
        actor: session.email,
      }));
    }

    if (action === "shift-request-review") {
      return Response.json(await reviewShiftRequest({
        id: String(body.id || ""),
        business,
        approve: body.approve === true,
        managerNote: body.managerNote ? String(body.managerNote) : "",
        actor: session.email,
      }));
    }

    if (action === "time-off-review") {
      return Response.json(await reviewTimeOff({
        id: String(body.id || ""),
        business,
        approve: body.approve === true,
        managerNote: body.managerNote ? String(body.managerNote) : "",
        actor: session.email,
      }));
    }

    if (action === "time-correction-review") {
      return Response.json(await reviewTimeCorrection({
        id: String(body.id || ""),
        business,
        approve: body.approve === true,
        managerNote: body.managerNote ? String(body.managerNote) : "",
        actor: session.email,
      }));
    }

    return Response.json({ error: "Unknown workforce action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

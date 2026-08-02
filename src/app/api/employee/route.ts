import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  createShiftRequest,
  employeeDashboard,
  requestTimeCorrection,
  requestTimeOff,
  respondToShiftRequest,
  sendEmployeeMessage,
  setEmployeeAvailability,
} from "@/lib/workforce";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    return Response.json(await employeeDashboard(session));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "message-send") {
      return Response.json(await sendEmployeeMessage(session, {
        recipientEmployeeId: body.recipientEmployeeId ? String(body.recipientEmployeeId) : null,
        body: String(body.body || ""),
      }));
    }
    if (action === "availability-save") {
      return Response.json(await setEmployeeAvailability(session, {
        weekday: Number(body.weekday),
        available: body.available !== false,
        availableFrom: body.availableFrom ? String(body.availableFrom) : "",
        availableTo: body.availableTo ? String(body.availableTo) : "",
        notes: body.notes ? String(body.notes) : "",
      }));
    }
    if (action === "time-off-request") {
      return Response.json(await requestTimeOff(session, {
        startsOn: String(body.startsOn || ""),
        endsOn: String(body.endsOn || ""),
        reason: body.reason ? String(body.reason) : "",
      }));
    }
    if (action === "shift-request") {
      const requestType = String(body.requestType || "");
      if (requestType !== "Claim" && requestType !== "Offer" && requestType !== "Swap") {
        throw new Error("Unknown shift request type.");
      }
      return Response.json(await createShiftRequest(session, {
        requestType,
        shiftId: String(body.shiftId || ""),
        offeredShiftId: body.offeredShiftId ? String(body.offeredShiftId) : null,
        targetEmployeeId: body.targetEmployeeId ? String(body.targetEmployeeId) : null,
        note: body.note ? String(body.note) : "",
      }));
    }
    if (action === "shift-response") {
      return Response.json(await respondToShiftRequest(session, {
        id: String(body.id || ""),
        accept: body.accept === true,
      }));
    }
    if (action === "time-correction-request") {
      return Response.json(await requestTimeCorrection(session, {
        sourceId: String(body.sourceId || ""),
        requestedClockIn: body.requestedClockIn ? String(body.requestedClockIn) : null,
        requestedClockOut: body.requestedClockOut ? String(body.requestedClockOut) : null,
        reason: String(body.reason || ""),
      }));
    }

    return Response.json({ error: "Unknown employee action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

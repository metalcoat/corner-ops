import { del, put } from "@vercel/blob";
import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import { sendEmployeePhotoMessage } from "@/lib/message-attachments";
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

const MAX_MESSAGE_PHOTO = 12 * 1024 * 1024;

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "photo.jpg";
}

function employeeMessagePath(business: string, fileName: string): string {
  const location = business === "Corner Deli" ? "corner-deli" : "tiki";
  return `employee-messages/${location}/${Date.now()}-${safeFileName(fileName)}`;
}

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
  let uploadedUrl = "";
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      if (String(form.get("action") || "") !== "message-send") {
        return Response.json({ error: "Unknown employee upload action." }, { status: 400 });
      }
      const cameraPhoto = form.get("cameraPhoto");
      const libraryPhoto = form.get("photo");
      const photo = cameraPhoto instanceof File && cameraPhoto.size > 0
        ? cameraPhoto
        : libraryPhoto instanceof File && libraryPhoto.size > 0
          ? libraryPhoto
          : null;
      const body = String(form.get("body") || "");
      const recipientEmployeeId = form.get("recipientEmployeeId")
        ? String(form.get("recipientEmployeeId"))
        : null;

      if (!photo) {
        return Response.json(await sendEmployeeMessage(session, { recipientEmployeeId, body }));
      }
      if (!photo.type.toLowerCase().startsWith("image/")) {
        return Response.json({ error: "Message attachments must be image files." }, { status: 415 });
      }
      if (photo.size > MAX_MESSAGE_PHOTO) {
        return Response.json({ error: "Message photos are limited to 12 MB." }, { status: 413 });
      }

      const blob = await put(employeeMessagePath(session.business, photo.name), photo, {
        access: "private",
        addRandomSuffix: true,
      });
      uploadedUrl = blob.url;
      const result = await sendEmployeePhotoMessage(session, {
        recipientEmployeeId,
        body,
        attachmentUrl: blob.url,
        attachmentPathname: blob.pathname,
        attachmentName: photo.name,
        attachmentType: photo.type || "application/octet-stream",
        attachmentSize: photo.size,
      });
      return Response.json(result, { status: 201 });
    }

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
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}

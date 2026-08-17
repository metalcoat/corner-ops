import { del, put } from "@/lib/storage";
import { getEmployeeSession, type EmployeeSession } from "@/lib/employee-auth";
import { listDirectoryEmployees } from "@/lib/employee-directory-admin";
import { employeePortalDashboard } from "@/lib/employee-portal-dashboard";
import { setEmployeeProfilePhoto, updateEmployeeChatNickname } from "@/lib/employee-profile";
import { apiError, unauthorized } from "@/lib/http";
import { sendEmployeePhotoMessage } from "@/lib/message-attachments";
import { markEmployeeMessageSeen } from "@/lib/message-reads";
import { notifyRecipientsOfEmployeeMessage } from "@/lib/push-notifications";
import {
  createShiftRequest,
  requestTimeCorrection,
  requestTimeOff,
  respondToShiftRequest,
  sendEmployeeMessage,
  setEmployeeAvailability,
} from "@/lib/workforce";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGE_PHOTO = 4 * 1024 * 1024;
const MAX_PROFILE_PHOTO = 4 * 1024 * 1024;

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "photo.jpg";
}

function employeeMessagePath(business: string, fileName: string): string {
  const location = business === "Corner Deli" ? "corner-deli" : "tiki";
  return `employee-messages/${location}/${Date.now()}-${safeFileName(fileName)}`;
}

function employeeProfilePath(business: string, employeeId: string, fileName: string): string {
  const location = business === "Corner Deli" ? "corner-deli" : "tiki";
  return `employee-profiles/${location}/${employeeId}/${Date.now()}-${safeFileName(fileName)}`;
}

async function sendMessagePush(
  session: EmployeeSession,
  input: { recipientEmployeeId?: string | null; body: string; hasPhoto?: boolean },
) {
  return notifyRecipientsOfEmployeeMessage({
    business: session.business,
    senderEmployeeId: session.employeeId,
    recipientEmployeeId: input.recipientEmployeeId,
    body: input.body,
    hasPhoto: input.hasPhoto,
  }).catch((error) => {
    console.error("[api/employee] employee message saved but push delivery failed", error);
    return { attempted: 0, delivered: 0, failed: 0 };
  });
}

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const [dashboard, directory] = await Promise.all([
      employeePortalDashboard(session),
      listDirectoryEmployees(session.business),
    ]);
    const byId = new Map(directory.map((employee) => [employee.id, employee]));
    const current = byId.get(session.employeeId);
    return Response.json({
      ...dashboard,
      employee: {
        ...dashboard.employee,
        scheduleColor: current?.scheduleColor || "#64748B",
        avatarSet: current?.avatarSet || false,
        chatNickname: current?.chatNickname || "",
      },
      directory: directory.filter((employee) => employee.active).map((employee) => ({
        id: employee.id,
        name: employee.name,
        position: employee.position,
        scheduleColor: employee.scheduleColor,
        avatarSet: employee.avatarSet,
        chatNickname: employee.chatNickname,
      })),
      teamShifts: dashboard.teamShifts.map((shift) => ({
        ...shift,
        employeeColor: shift.employeeId ? byId.get(shift.employeeId)?.scheduleColor || "#64748B" : "#64748B",
        employeeAvatarSet: shift.employeeId ? byId.get(shift.employeeId)?.avatarSet || false : false,
      })),
      messages: (dashboard.messages as Array<Record<string, unknown>>).map((message) => {
        const senderId = message.sender_employee_id ? String(message.sender_employee_id) : "";
        const sender = senderId ? byId.get(senderId) : undefined;
        return {
          ...message,
          sender_schedule_color: sender?.scheduleColor || "#64748B",
          sender_avatar_set: sender?.avatarSet || false,
          sender_chat_nickname: sender?.chatNickname || "",
        };
      }),
    });
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
      const action = String(form.get("action") || "");

      if (action === "profile-photo") {
        const cameraPhoto = form.get("cameraProfilePhoto");
        const libraryPhoto = form.get("profilePhoto");
        const photo = cameraPhoto instanceof File && cameraPhoto.size > 0
          ? cameraPhoto
          : libraryPhoto instanceof File && libraryPhoto.size > 0
            ? libraryPhoto
            : null;
        if (!photo) throw new Error("Choose a profile photo.");
        if (!photo.type.toLowerCase().startsWith("image/")) {
          return Response.json({ error: "Profile photos must be image files." }, { status: 415 });
        }
        if (photo.size > MAX_PROFILE_PHOTO) {
          return Response.json({ error: "Profile photos are limited to 4 MB after resizing." }, { status: 413 });
        }
        const blob = await put(employeeProfilePath(session.business, session.employeeId, photo.name), photo, {
          access: "private",
          addRandomSuffix: true,
        });
        uploadedUrl = blob.url;
        const result = await setEmployeeProfilePhoto({
          business: session.business,
          employeeId: session.employeeId,
          url: blob.url,
          pathname: blob.pathname,
          fileName: photo.name,
          contentType: photo.type || "application/octet-stream",
          size: photo.size,
        });
        if (result.previousUrl && result.previousUrl !== blob.url) await del(result.previousUrl).catch(() => undefined);
        return Response.json({ uploaded: true }, { status: 201 });
      }

      if (action !== "message-send") {
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
        const result = await sendEmployeeMessage(session, { recipientEmployeeId, body });
        const push = await sendMessagePush(session, { recipientEmployeeId, body });
        return Response.json({ ...result, push });
      }
      if (!photo.type.toLowerCase().startsWith("image/")) {
        return Response.json({ error: "Message attachments must be image files." }, { status: 415 });
      }
      if (photo.size > MAX_MESSAGE_PHOTO) {
        return Response.json({ error: "Message photos are limited to 4 MB after resizing." }, { status: 413 });
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
      const push = await sendMessagePush(session, { recipientEmployeeId, body, hasPhoto: true });
      return Response.json({ ...result, push }, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "nickname-update") {
      return Response.json(await updateEmployeeChatNickname(session, body.nickname));
    }
    if (action === "message-seen") {
      return Response.json(await markEmployeeMessageSeen(session, String(body.messageId || "")));
    }
    if (action === "message-send") {
      const recipientEmployeeId = body.recipientEmployeeId ? String(body.recipientEmployeeId) : null;
      const messageBody = String(body.body || "");
      const result = await sendEmployeeMessage(session, {
        recipientEmployeeId,
        body: messageBody,
      });
      const push = await sendMessagePush(session, { recipientEmployeeId, body: messageBody });
      return Response.json({ ...result, push });
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

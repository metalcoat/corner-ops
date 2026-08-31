import { del, put } from "@vercel/blob";
import { getEmployeeSession, type EmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  employeeConversationDashboard,
  markConversationMessageSeen,
  sendConversationMessage,
  TEAM_CONVERSATION_KEY,
} from "@/lib/message-conversations";
import { deleteEmployeeMessage } from "@/lib/message-deletion";
import {
  notifyOwnersOfOperationalPush,
  notifyRecipientsOfEmployeeMessage,
} from "@/lib/push-notifications";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGE_PHOTO = 4 * 1024 * 1024;

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "photo.jpg";
}

function employeeMessagePath(business: string, fileName: string): string {
  const location = business === "Corner Deli" ? "corner-deli" : "tiki";
  return `employee-messages/${location}/${Date.now()}-${safeFileName(fileName)}`;
}

async function sendPush(
  session: EmployeeSession,
  result: {
    conversationKey: string;
    pushRecipientEmployeeIds: string[];
    notifyOwnersOnly: boolean;
  },
  body: string,
  hasPhoto: boolean,
) {
  const messageBody = body.trim() || (hasPhoto ? "Sent a photo." : "Sent a new message.");
  if (result.notifyOwnersOnly) {
    return notifyOwnersOfOperationalPush({
      business: session.business,
      title: `${session.business}: message from ${session.name.split(/\s+/)[0] || session.name}`,
      body: messageBody,
      url: `/ops/messages?business=${encodeURIComponent(session.business)}`,
      tag: `owner-message-${session.business}`,
    });
  }
  if (result.conversationKey === TEAM_CONVERSATION_KEY) {
    return notifyRecipientsOfEmployeeMessage({
      business: session.business,
      senderEmployeeId: session.employeeId,
      recipientEmployeeId: null,
      body: messageBody,
      hasPhoto,
    });
  }
  const recipientEmployeeId = result.pushRecipientEmployeeIds[0] || null;
  return notifyRecipientsOfEmployeeMessage({
    business: session.business,
    senderEmployeeId: session.employeeId,
    recipientEmployeeId,
    body: messageBody,
    hasPhoto,
  });
}

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    return Response.json(await employeeConversationDashboard(session), {
      headers: { "Cache-Control": "private, no-store" },
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
      const action = String(form.get("action") || "message-send");
      if (action !== "message-send") {
        return Response.json({ error: "Unknown conversation upload action." }, { status: 400 });
      }
      const cameraPhoto = form.get("cameraPhoto");
      const libraryPhoto = form.get("photo");
      const photo = cameraPhoto instanceof File && cameraPhoto.size > 0
        ? cameraPhoto
        : libraryPhoto instanceof File && libraryPhoto.size > 0
          ? libraryPhoto
          : null;
      const body = String(form.get("body") || "");
      const conversationKey = String(form.get("conversationKey") || TEAM_CONVERSATION_KEY);

      let attachment: {
        url: string;
        pathname: string;
        name: string;
        type: string;
        size: number;
      } | null = null;
      if (photo) {
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
        attachment = {
          url: blob.url,
          pathname: blob.pathname,
          name: photo.name,
          type: photo.type || "application/octet-stream",
          size: photo.size,
        };
      }

      const result = await sendConversationMessage({
        business: session.business,
        conversationKey,
        senderEmployeeId: session.employeeId,
        senderName: session.name,
        body,
        attachment,
      });
      uploadedUrl = "";
      const push = await sendPush(session, result, body, Boolean(photo)).catch((error) => {
        console.error("[api/employee/message-conversations] push failed", error);
        return { attempted: 0, delivered: 0, failed: 0 };
      });
      return Response.json({ ...result, push }, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "message-send");
    if (action === "message-seen") {
      return Response.json(await markConversationMessageSeen(session, body.messageId));
    }
    if (action === "delete") {
      return Response.json(await deleteEmployeeMessage(session, String(body.id || "")));
    }
    if (action !== "message-send") {
      return Response.json({ error: "Unknown conversation action." }, { status: 400 });
    }

    const messageBody = String(body.body || "");
    const result = await sendConversationMessage({
      business: session.business,
      conversationKey: body.conversationKey,
      senderEmployeeId: session.employeeId,
      senderName: session.name,
      body: messageBody,
    });
    const push = await sendPush(session, result, messageBody, false).catch((error) => {
      console.error("[api/employee/message-conversations] push failed", error);
      return { attempted: 0, delivered: 0, failed: 0 };
    });
    return Response.json({ ...result, push }, { status: 201 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}

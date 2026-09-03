import { del, put } from "@vercel/blob";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  ownerConversationDashboard,
  sendConversationMessage,
  TEAM_CONVERSATION_KEY,
} from "@/lib/message-conversations";
import { deleteOwnerMessage } from "@/lib/message-deletion";
import { markAdminMessagesRead } from "@/lib/message-reads";
import { notifyEmployeesOfOwnerMessage } from "@/lib/push-notifications";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGE_PHOTO = 4 * 1024 * 1024;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function mergePush(results: Array<{ attempted: number; delivered: number; failed: number }>) {
  return results.reduce((total, result) => ({
    attempted: total.attempted + Number(result.attempted || 0),
    delivered: total.delivered + Number(result.delivered || 0),
    failed: total.failed + Number(result.failed || 0),
  }), { attempted: 0, delivered: 0, failed: 0 });
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "photo.jpg";
}

function ownerMessagePath(business: Business, fileName: string): string {
  const location = business === "Corner Deli" ? "corner-deli" : "tiki";
  return `owner-messages/${location}/${Date.now()}-${safeFileName(fileName)}`;
}

async function sendOwnerPush(input: {
  business: Business;
  result: { conversationKey: string; pushRecipientEmployeeIds: string[] };
  body: string;
  hasPhoto: boolean;
  actor: string;
}) {
  const messageBody = input.body.trim() || (input.hasPhoto ? "Sent a photo." : "Sent a new message.");
  const pushResults = input.result.conversationKey === TEAM_CONVERSATION_KEY
    ? [await notifyEmployeesOfOwnerMessage({
        business: input.business,
        recipientEmployeeId: null,
        body: messageBody,
        actor: input.actor,
      }).catch((error: unknown) => {
        console.error("[api/message-conversations] team push failed", error);
        return { attempted: 0, delivered: 0, failed: 0 };
      })]
    : await Promise.all(input.result.pushRecipientEmployeeIds.map((employeeId: string) =>
        notifyEmployeesOfOwnerMessage({
          business: input.business,
          recipientEmployeeId: employeeId,
          body: messageBody,
          actor: input.actor,
        }).catch((error: unknown) => {
          console.error("[api/message-conversations] employee push failed", error);
          return { attempted: 0, delivered: 0, failed: 0 };
        }),
      ));
  return mergePush(pushResults);
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.read");
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    const viewAsEmployeeId = url.searchParams.get("viewAsEmployeeId") || "";
    if (!viewAsEmployeeId) await markAdminMessagesRead(session.email, business);
    return Response.json(await ownerConversationDashboard(business, viewAsEmployeeId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl = "";
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.write");
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const action = String(form.get("action") || "send");
      if (action !== "send") {
        return Response.json({ error: "Unknown conversation upload action." }, { status: 400 });
      }
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const conversationKey = String(form.get("conversationKey") || TEAM_CONVERSATION_KEY);
      if (conversationKey.toLowerCase().startsWith("direct:")) {
        return Response.json({
          error: "Employee-to-employee conversations are view-only for management. Use an employee conversation or the entire team.",
        }, { status: 400 });
      }
      const body = String(form.get("body") || "");
      const cameraPhoto = form.get("cameraPhoto");
      const libraryPhoto = form.get("photo");
      const photo = cameraPhoto instanceof File && cameraPhoto.size > 0
        ? cameraPhoto
        : libraryPhoto instanceof File && libraryPhoto.size > 0
          ? libraryPhoto
          : null;

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
        const blob = await put(ownerMessagePath(business, photo.name), photo, {
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
        business,
        conversationKey,
        senderName: session.email,
        body,
        attachment,
      });
      uploadedUrl = "";
      const push = await sendOwnerPush({
        business,
        result,
        body,
        hasPhoto: Boolean(photo),
        actor: session.email,
      });
      return Response.json({ ...result, push }, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    const action = String(body.action || "send");
    if (action === "delete") {
      return Response.json(await deleteOwnerMessage({
        id: String(body.id || ""),
        business,
        actor: session.email,
        reason: "Owner removed conversation message",
      }));
    }
    if (action !== "send") {
      return Response.json({ error: "Unknown conversation action." }, { status: 400 });
    }

    const conversationKey = String(body.conversationKey || TEAM_CONVERSATION_KEY);
    if (conversationKey.toLowerCase().startsWith("direct:")) {
      return Response.json({
        error: "Employee-to-employee conversations are view-only for management. Use an employee conversation or the entire team.",
      }, { status: 400 });
    }

    const messageBody = String(body.body || "");
    const result = await sendConversationMessage({
      business,
      conversationKey,
      senderName: session.email,
      body: messageBody,
    });
    const push = await sendOwnerPush({
      business,
      result,
      body: messageBody,
      hasPhoto: false,
      actor: session.email,
    });
    return Response.json({ ...result, push }, { status: 201 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}

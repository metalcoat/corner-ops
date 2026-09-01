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
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.write");
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

    const result = await sendConversationMessage({
      business,
      conversationKey,
      senderName: session.email,
      body: body.body,
    });

    const messageBody = String(body.body || "");
    const pushResults = result.conversationKey === TEAM_CONVERSATION_KEY
      ? [await notifyEmployeesOfOwnerMessage({
          business,
          recipientEmployeeId: null,
          body: messageBody,
          actor: session.email,
        }).catch((error: unknown) => {
          console.error("[api/message-conversations] team push failed", error);
          return { attempted: 0, delivered: 0, failed: 0 };
        })]
      : await Promise.all(result.pushRecipientEmployeeIds.map((employeeId: string) =>
          notifyEmployeesOfOwnerMessage({
            business,
            recipientEmployeeId: employeeId,
            body: messageBody,
            actor: session.email,
          }).catch((error: unknown) => {
            console.error("[api/message-conversations] employee push failed", error);
            return { attempted: 0, delivered: 0, failed: 0 };
          }),
        ));

    return Response.json({ ...result, push: mergePush(pushResults) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

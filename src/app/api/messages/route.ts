import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  adminMessagesDashboard,
  adminUnreadMessageSummary,
  markAdminMessagesRead,
} from "@/lib/message-reads";
import { sendOwnerMessage } from "@/lib/workforce";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function readBusiness(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.read");
    const url = new URL(request.url);

    if (url.searchParams.get("summary") === "nav") {
      return Response.json(await adminUnreadMessageSummary(session.email, session.businesses));
    }

    const business = readBusiness(url.searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    if (url.searchParams.get("markRead") === "1") {
      await markAdminMessagesRead(session.email, business);
    }
    return Response.json(await adminMessagesDashboard(business));
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
    const business = readBusiness(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json(await sendOwnerMessage({
      business,
      recipientEmployeeId: body.recipientEmployeeId ? String(body.recipientEmployeeId) : null,
      body: String(body.body || ""),
      actor: session.email,
    }));
  } catch (error) {
    return apiError(error);
  }
}

import { del } from "@vercel/blob";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { deleteOwnerMessage } from "@/lib/message-deletion";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function readBusiness(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.write");
    const body = await request.json() as { id?: unknown; business?: unknown };
    const business = readBusiness(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const deleted = await deleteOwnerMessage({ id: String(body.id || ""), business });
    if (deleted.attachmentUrl) {
      await del(deleted.attachmentUrl).catch((error) => {
        console.error("[api/messages/delete] message deleted but blob cleanup failed", error);
      });
    }
    return Response.json({ deleted: true, id: deleted.id });
  } catch (error) {
    return apiError(error);
  }
}

import { listAuditEvents } from "@/lib/audit";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { assertConfigured } from "@/lib/config";
import { apiError, unauthorized } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = new URL(request.url).searchParams.get("business") || "";
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Unknown or inaccessible business." }, { status: 403 });
    }
    assertConfigured("DATABASE_URL");
    return Response.json({ events: await listAuditEvents(business) });
  } catch (error) {
    return apiError(error);
  }
}

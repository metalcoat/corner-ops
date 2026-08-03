import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { performanceReport } from "@/lib/reporting";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "reports.read");

    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business") || "Tiki");
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    return Response.json(await performanceReport({
      business,
      start: String(url.searchParams.get("start") || ""),
      end: String(url.searchParams.get("end") || ""),
      compareStart: url.searchParams.get("compareStart") || undefined,
      compareEnd: url.searchParams.get("compareEnd") || undefined,
      // Reports read stored data. Institution/POS synchronization belongs to Integrations
      // and must never run merely because a manager switches businesses or report tabs.
      refresh: false,
    }));
  } catch (error) {
    return apiError(error);
  }
}

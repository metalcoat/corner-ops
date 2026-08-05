import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { evaluateAndNotifyOvertimeRisk, overtimeRiskDashboard } from "@/lib/overtime-risk";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
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
    return Response.json(await overtimeRiskDashboard(business, url.searchParams.get("weekStart") || undefined));
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
    if (String(body.action || "") !== "run-check") {
      return Response.json({ error: "Unknown overtime action." }, { status: 400 });
    }
    return Response.json(await evaluateAndNotifyOvertimeRisk({
      business,
      source: `Manual check by ${session.displayName}`,
      notify: true,
    }));
  } catch (error) {
    return apiError(error);
  }
}

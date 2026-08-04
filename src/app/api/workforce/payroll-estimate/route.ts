import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { scheduledPayrollEstimate } from "@/lib/workforce-cost";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function business(value: string | null): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Choose Corner Deli or Tiki.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const url = new URL(request.url);
    const selectedBusiness = business(url.searchParams.get("business"));
    if (!canAccessBusiness(session, selectedBusiness)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json(await scheduledPayrollEstimate(selectedBusiness, String(url.searchParams.get("weekStart") || "")));
  } catch (error) {
    return apiError(error);
  }
}

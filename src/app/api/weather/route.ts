import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";
import { weatherSalesIntelligence } from "@/lib/weather-intelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

function businessFrom(value: string | null): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json(await weatherSalesIntelligence({
      business,
      start: String(url.searchParams.get("start") || ""),
      end: String(url.searchParams.get("end") || ""),
    }));
  } catch (error) {
    return apiError(error);
  }
}

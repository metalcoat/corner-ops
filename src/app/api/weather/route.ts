import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";
import { weatherSalesIntelligence } from "@/lib/weather-intelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

const REPORT_WEATHER_TIMEOUT_MS = 8_000;

function businessFrom(value: string | null): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

async function reportWeatherWithTimeout(input: { business: Business; start: string; end: string }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_WEATHER_TIMEOUT_MS);
  try {
    return await weatherSalesIntelligence(input, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Weather intelligence is taking too long. Stored performance data is still available; refresh weather again later.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
    return Response.json(await reportWeatherWithTimeout({
      business,
      start: String(url.searchParams.get("start") || ""),
      end: String(url.searchParams.get("end") || ""),
    }));
  } catch (error) {
    return apiError(error);
  }
}

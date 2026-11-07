import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { getStaleDraftSettings, listStaleDrafts, saveStaleDraftSettings, snoozeStaleDraft, staleDraftStations } from "@/lib/ordering-stale-drafts";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

export async function GET(request: Request) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const url = new URL(request.url);
    if (url.searchParams.get("settings") === "1") return isoJson({ settings: await getStaleDraftSettings(), stations: await staleDraftStations() });
    return isoJson(await listStaleDrafts(url.searchParams.get("stationKey") || ""));
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const body = await request.json() as { action?: unknown; orderId?: unknown };
    if (body.action !== "snooze") return isoJson({ error: "Unknown action." }, { status: 400 });
    return isoJson(await snoozeStaleDraft(String(body.orderId || ""), actor));
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    if (!canManagePos(actor)) return isoJson({ error: "Manager or owner access is required." }, { status: 403 });
    try { return isoJson({ settings: await saveStaleDraftSettings(await request.json() as Record<string, unknown>, actor) }); }
    catch (error) { return isoJson({ error: error instanceof Error ? error.message : "Could not save." }, { status: 409 }); }
  } catch (error) { return apiError(error); }
}

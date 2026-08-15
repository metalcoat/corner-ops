import { apiError, unauthorized } from "@/lib/http";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { orderingOperationalReport } from "@/lib/ordering-operational-report";
import type { OrderingBusiness } from "@/lib/ordering-core";

export const runtime = "nodejs";
function business(value: string | null): OrderingBusiness { if (value === "Corner Deli" || value === "Tiki") return value; throw new Error("Unknown business."); }
export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const selected = business(url.searchParams.get("business"));
    const actor = await orderingActor(selected);
    if (!actor) return unauthorized();
    if (!canManagePos(actor)) return Response.json({ error: "Manager or owner authorization is required for reports." }, { status: 403 });
    return Response.json(await orderingOperationalReport({ business: selected, start: String(url.searchParams.get("start") || ""), end: String(url.searchParams.get("end") || "") }));
  } catch (error) { return apiError(error); }
}

import { apiError, unauthorized } from "@/lib/http";
import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { orderingActor } from "@/lib/ordering-route-auth";
import { applyScheduledMenuAvailability } from "@/lib/ordering-menu-availability";

export const runtime = "nodejs";

function readBusiness(value: string | null): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const business = readBusiness(new URL(request.url).searchParams.get("business") || "Corner Deli");
    if (!await orderingActor(business)) return unauthorized();
    const params = new URL(request.url).searchParams;
    const channel=params.get("channel")==="web"?"web":"pos";
    const requested = params.get("scheduledFor");
    const at = requested ? new Date(requested) : new Date();
    if (!Number.isFinite(at.getTime())) return Response.json({ error: "Invalid scheduled menu time." }, { status: 400 });
    const categories = await orderingMenuWithVariants(business,channel);
    return Response.json({ business,channel,categories:await applyScheduledMenuAvailability(business, at, categories as unknown as Array<Record<string, any>>) });
  } catch (error) {
    return apiError(error);
  }
}

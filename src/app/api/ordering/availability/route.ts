import { apiError, unauthorized } from "@/lib/http";
import { listFutureOrderingSlots, resolveOrderingAvailability } from "@/lib/ordering-availability";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    if (!await orderingActor("Corner Deli")) return unauthorized();
    const params = new URL(request.url).searchParams;
    const serviceType = params.get("serviceType") || "pickup";
    const businessDate = params.get("date");
    if (businessDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return Response.json({ error: "A valid date is required." }, { status: 400 });
      const slots = await listFutureOrderingSlots({ business: "Corner Deli", serviceType, businessDate });
      return Response.json({ businessDate, slots: slots.map((slot) => slot.toISOString()) });
    }
    return Response.json({ availability: await resolveOrderingAvailability({ business: "Corner Deli", serviceType }) });
  } catch (error) { return apiError(error); }
}

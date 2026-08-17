import { listFutureOrderingSlots, resolveOrderingAvailability } from "@/lib/ordering-availability";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const serviceType = params.get("serviceType") === "delivery" ? "delivery" : "pickup";
    const date = params.get("date");
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "A valid date is required." }, { status: 400 });
      const slots = await listFutureOrderingSlots({ business: "Corner Deli", serviceType, businessDate: date });
      return Response.json({ date, slots: slots.map((slot) => slot.toISOString()) });
    }
    return Response.json({ availability: await resolveOrderingAvailability({ business: "Corner Deli", serviceType }) });
  } catch (error) { console.error(error); return Response.json({ error: "Availability is temporarily unavailable." }, { status: 500 }); }
}

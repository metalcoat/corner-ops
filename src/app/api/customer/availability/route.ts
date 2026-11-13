import { isoJson } from "@/lib/timestamp-values";
import { listFutureOrderingSlots, resolveOrderingAvailability } from "@/lib/ordering-availability";
import { getFulfillmentTimingSettings } from "@/lib/ordering-timing";
import { orderingLocalDateTime, quoteOrderTiming } from "@/lib/ordering-timing-core";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const requestedService = params.get("serviceType");
    const serviceType = requestedService === "delivery" || requestedService === "curbside" ? requestedService : "pickup";
    const date = params.get("date");
    if (date !== null) {
      const calendarDate = new Date(`${date}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-")
        || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date)
        return isoJson({ date, slots: [], error: "A valid calendar date is required." }, { status: 400 });
      const now = new Date();
      const timing = await getFulfillmentTimingSettings("Corner Deli", serviceType);
      const quote = (requestedFor: Date) => quoteOrderTiming({ now, mode: "future", requestedFor, settings: timing, currentOrdersInBusyWindow: 0 });
      const unavailable = (requestedFor: Date) => {
        const result = quote(requestedFor);
        return isoJson({ date, slots: [], error: result.customerMessage, reason: result.reason });
      };
      if (!timing.allowFuture) return unavailable(now);
      const { timezone } = await resolveOrderingAvailability({ business: "Corner Deli", serviceType, at: now });
      if (date < orderingLocalDateTime(now, timezone).date) return unavailable(now);
      const horizonMs = Math.max(0, timing.maxFutureDays) * 86_400_000;
      if (horizonMs > 0 && date > orderingLocalDateTime(new Date(now.getTime() + horizonMs), timezone).date)
        return unavailable(new Date(now.getTime() + horizonMs + 1));
      const candidates = await listFutureOrderingSlots({ business: "Corner Deli", serviceType, businessDate: date, now, leadMinutes: timing.normalMinMinutes });
      // The last allowed day can be only partly inside the rolling timing
      // horizon. Use checkout's quote for each instant, including across DST.
      const slots = candidates.filter((slot) => quote(slot).accepted);
      if (!slots.length) return isoJson({ date, slots: [], error: "No future times are available for this date. Choose another date." });
      return isoJson({ date, slots: slots.map((slot) => slot.toISOString()) });
    }
    return isoJson({ availability: await resolveOrderingAvailability({ business: "Corner Deli", serviceType }) });
  } catch (error) { console.error(error); return isoJson({ error: "Availability is temporarily unavailable." }, { status: 500 }); }
}

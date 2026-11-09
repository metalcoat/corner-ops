import { isoJson } from "@/lib/timestamp-values";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { customerSessionHash, readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { getSql } from "@/lib/db";
import { unauthorized } from "@/lib/http";
import { CURBSIDE_CHECK_IN_STATUSES, parseCurbsideArrival } from "@/lib/curbside-arrival-policy";
import { recordCurbsideArrival } from "@/lib/curbside-arrivals";
import { waitingForOpening } from "@/lib/customer-order-progress";

export const runtime = "nodejs";

/** A curbside customer taps "I'm here" on their order page and says which car to look for. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = readCustomerOrderingSession(request);
    if (!session) return unauthorized();
    const { id } = await context.params;
    await ensureCustomerOrderingSchema();
    const order = (await getSql()`
      SELECT orders.id, orders.business, orders.status, orders.service_type,
        orders.timing_mode,orders.promised_at,orders.quoted_lead_max_minutes,
        COALESCE(orders.status='sent_to_kitchen' AND orders.kitchen_release_at>NOW(),FALSE) held_until_prep
      FROM ordering_customer_web_carts carts JOIN ordering_orders orders ON orders.id = carts.order_id
      WHERE carts.order_id = ${id} AND carts.session_hash = ${customerSessionHash(session.sessionId)} LIMIT 1
    `)[0];
    if (!order) return unauthorized();
    if (order.service_type !== "curbside") return isoJson({ error: "This isn't a curbside order." }, { status: 409 });
    if (!CURBSIDE_CHECK_IN_STATUSES.includes(String(order.status)))
      return isoJson({ error: "This order isn't waiting for pickup." }, { status: 409 });
    if (waitingForOpening({ status: String(order.status), timing_mode: order.timing_mode,
      promised_at: order.promised_at, quoted_lead_max_minutes: order.quoted_lead_max_minutes }))
      return isoJson({ error: "Your preorder is queued for the next opening. Check in after the store opens." }, { status: 409 });
    if (order.held_until_prep)
      return isoJson({ error: "Your order is scheduled for later. Check in closer to your pickup time." }, { status: 409 });
    const car = parseCurbsideArrival(await request.json().catch(() => ({})));
    await recordCurbsideArrival(id, String(order.business), car);
    return isoJson({ arrived: true, ...car });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Could not check you in." }, { status: 400 });
  }
}

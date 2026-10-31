import { isoJson } from "@/lib/timestamp-values";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { customerSessionHash, readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { getSql } from "@/lib/db";
import { unauthorized } from "@/lib/http";
import { CURBSIDE_CHECK_IN_STATUSES, parseCurbsideArrival } from "@/lib/curbside-arrival-policy";
import { recordCurbsideArrival } from "@/lib/curbside-arrivals";

export const runtime = "nodejs";

/** A curbside customer taps "I'm here" on their order page and says which car to look for. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = readCustomerOrderingSession(request);
    if (!session) return unauthorized();
    const { id } = await context.params;
    await ensureCustomerOrderingSchema();
    const order = (await getSql()`
      SELECT orders.id, orders.business, orders.status, orders.service_type
      FROM ordering_customer_web_carts carts JOIN ordering_orders orders ON orders.id = carts.order_id
      WHERE carts.order_id = ${id} AND carts.session_hash = ${customerSessionHash(session.sessionId)} LIMIT 1
    `)[0];
    if (!order) return unauthorized();
    if (order.service_type !== "curbside") return isoJson({ error: "This isn't a curbside order." }, { status: 409 });
    if (!CURBSIDE_CHECK_IN_STATUSES.includes(String(order.status)))
      return isoJson({ error: "This order isn't waiting for pickup." }, { status: 409 });
    const car = parseCurbsideArrival(await request.json().catch(() => ({})));
    await recordCurbsideArrival(id, String(order.business), car);
    return isoJson({ arrived: true, ...car });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Could not check you in." }, { status: 400 });
  }
}

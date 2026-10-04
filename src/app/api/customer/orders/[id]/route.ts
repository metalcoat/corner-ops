import { customerOrderConfirmation } from "@/lib/customer-order-confirmation";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import {
  customerSessionHash,
  readCustomerOrderingSession,
} from "@/lib/customer-ordering-session";
import { getSql } from "@/lib/db";
import { unauthorized } from "@/lib/http";
import { deliveryOrigin } from "@/lib/ordering-delivery-route";
import { webOrderDelivery } from "@/lib/ordering-driver-delivery";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = readCustomerOrderingSession(request);
  if (!session) return unauthorized();
  const { id } = await context.params;
  await ensureCustomerOrderingSchema();
  const rows =
    await getSql()`SELECT 1 FROM ordering_customer_web_carts WHERE order_id=${id} AND session_hash=${customerSessionHash(session.sessionId)} LIMIT 1`;
  if (!rows[0]) return unauthorized();
  const order = await customerOrderConfirmation(id);
  if (!order)
    return Response.json({ error: "Order not found." }, { status: 404 });
  // Delivery orders get the live tracker: driver status, and (when the store
  // turns it on) the driver's approximate position on a map.
  const delivery =
    order.service_type === "delivery" || order.service_type === "no_contact_delivery"
      ? await webOrderDelivery(id).catch((error) => {
          console.error("Web order delivery tracker failed", error);
          return null;
        })
      : null;
  return Response.json({
    order,
    delivery,
    store: deliveryOrigin(),
    mapTileUrl: process.env.MAP_TILE_URL?.trim() || null,
  });
}

import { addressForOrder, routeDeliveryAddress } from "@/lib/ordering-address";
import { saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";
import {
  customerOrderingSession,
  customerSessionHash,
} from "@/lib/customer-ordering-session";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { quoteDelivery } from "@/lib/ordering-delivery";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { session } = customerOrderingSession(request);
    await ensureCustomerOrderingSchema();
    const sql = getSql(),
      hash = customerSessionHash(session.sessionId);
    const order = (
      await sql`SELECT o.id,o.status,o.service_type,o.subtotal_cents FROM ordering_customer_web_carts c JOIN ordering_orders o ON o.id=c.order_id WHERE c.order_id=${id} AND c.session_hash=${hash} AND c.replaced_at IS NULL LIMIT 1`
    )[0];
    if (!order)
      return Response.json({ error: "Order not found." }, { status: 404 });
    if (order.status !== "draft" || order.service_type !== "delivery")
      return Response.json(
        { error: "This delivery order can no longer be updated." },
        { status: 409 },
      );
    const body = (await request.json()) as Record<string, unknown>;
    const enteredAddress = String(body.enteredAddress || "");
    const address = addressForOrder(
      "delivery",
      String(body.validationToken || ""),
      enteredAddress,
    );
    if (!address) throw new Error("A validated delivery address is required.");
    const route = await routeDeliveryAddress(address);
    const quote = await quoteDelivery({
      business: "Corner Deli",
      distanceMiles: route.distanceMiles,
      merchandiseSubtotalCents: Number(order.subtotal_cents),
    });
    await saveOrderDeliveryAddress({
      orderId: id,
      address,
      line2: String(body.line2 || ""),
      route,
    });
    await sql`UPDATE ordering_orders SET delivery_fee_cents=${quote.deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}-paid_cents),version=version+1,updated_at=NOW() WHERE id=${id}`;
    const updated = (
      await sql`SELECT total_cents,amount_due_cents,delivery_fee_cents FROM ordering_orders WHERE id=${id}`
    )[0];
    return Response.json({
      address,
      route,
      quote,
      totalCents: Number(updated.total_cents),
      amountDueCents: Number(updated.amount_due_cents),
      deliveryFeeCents: Number(updated.delivery_fee_cents),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not save the delivery address.",
      },
      { status: 409 },
    );
  }
}

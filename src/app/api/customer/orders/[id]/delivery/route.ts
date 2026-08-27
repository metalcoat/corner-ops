import { addressForOrder, routeDeliveryAddress } from "@/lib/ordering-address";
import { saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";
import {
  customerOrderingSession,
  customerSessionHash,
} from "@/lib/customer-ordering-session";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { quoteDelivery } from "@/lib/ordering-delivery";
import { getSql } from "@/lib/db";
import { addCustomerAddress } from "@/lib/ordering-customers";

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
      await sql`SELECT o.id,o.status,o.service_type,o.subtotal_cents,o.customer_id FROM ordering_customer_web_carts c JOIN ordering_orders o ON o.id=c.order_id WHERE c.order_id=${id} AND c.session_hash=${hash} AND c.replaced_at IS NULL LIMIT 1`
    )[0];
    if (!order)
      return Response.json({ error: "Order not found." }, { status: 404 });
    if (order.status !== "draft" || order.service_type !== "delivery")
      return Response.json(
        { error: "This delivery order can no longer be updated." },
        { status: 409 },
      );
    const body = (await request.json()) as Record<string, unknown>;
    const requestedAddressId = String(body.customerAddressId || "");
    const saved =
      requestedAddressId && order.customer_id
        ? (
            await sql`SELECT * FROM ordering_customer_addresses WHERE id=${requestedAddressId} AND customer_id=${order.customer_id} AND active=TRUE LIMIT 1`
          )[0]
        : null;
    const enteredAddress = String(
      body.enteredAddress || saved?.standardized_address || "",
    );
    const address = saved
      ? {
          enteredAddress,
          formattedAddress: String(
            saved.standardized_address ||
              [saved.line1, saved.city, saved.state, saved.postal_code]
                .filter(Boolean)
                .join(", "),
          ),
          line1: String(saved.line1),
          city: String(saved.city),
          state: String(saved.state),
          postalCode: String(saved.postal_code),
          country: "US",
          latitude: Number(saved.latitude),
          longitude: Number(saved.longitude),
          provider: "google" as const,
          providerReferenceId: String(saved.provider_reference_id || ""),
          validatedAt: new Date().toISOString(),
        }
      : addressForOrder(
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
    let customerAddressId = saved ? String(saved.id) : null;
    if (!saved && order.customer_id) {
      customerAddressId = await addCustomerAddress({
        business: "Corner Deli",
        customerId: String(order.customer_id),
        label: String(body.label || "Delivery"),
        line1: address.line1,
        line2: String(body.line2 || ""),
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        standardizedAddress: address.formattedAddress,
        provider: address.provider,
        providerReferenceId: address.providerReferenceId,
        latitude: address.latitude,
        longitude: address.longitude,
        isPrimary: body.makeDefault === true,
      });
    }
    await saveOrderDeliveryAddress({
      orderId: id,
      address,
      line2: saved ? String(saved.line2 || "") : String(body.line2 || ""),
      customerAddressId,
      route,
    });
    await sql`UPDATE ordering_orders SET delivery_fee_cents=${quote.deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}-paid_cents),version=version+1,updated_at=NOW() WHERE id=${id}`;
    const updated = (
      await sql`SELECT total_cents,amount_due_cents,delivery_fee_cents FROM ordering_orders WHERE id=${id}`
    )[0];
    return Response.json({
      address,
      customerAddressId,
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

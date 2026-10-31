import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { addressForOrder, routeDeliveryAddress, validateDeliveryAddress, type ValidatedDeliveryAddress } from "@/lib/ordering-address";
import { saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";
import { merchandiseAfterDiscounts, quoteDelivery } from "@/lib/ordering-delivery";
import { OrderConflictError, syncDraftTotals } from "@/lib/ordering-order-lifecycle";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";

export type FulfillmentChange = {
  serviceType: "pickup" | "delivery";
  /** The address the POS just validated. Left out, the order's or customer's own address is used. */
  deliveryAddress?: string;
  deliveryUnit?: string;
  deliveryValidationToken?: string;
};

/** Thrown when an order is switched to delivery and nothing on file says where to. */
export class DeliveryAddressNeededError extends Error {
  constructor() {
    super("Enter the delivery address.");
  }
}

/** A sent order only takes changes while it is reopened from the Order Center. */
export async function orderOpenForChanges(orderId: string, order: { status?: unknown; submitted_at?: unknown } | undefined): Promise<boolean> {
  if (order?.status !== "draft") return false;
  if (!order.submitted_at) return true;
  const reopen = await getSql()`SELECT 1 FROM ordering_order_events WHERE order_id=${orderId} AND event_type='order_reopened_for_additions' AND NOT EXISTS(SELECT 1 FROM ordering_order_events later WHERE later.order_id=${orderId} AND later.event_type='order_addition_submitted' AND later.created_at>ordering_order_events.created_at) ORDER BY created_at DESC LIMIT 1`;
  return reopen.length > 0;
}

type ResolvedAddress = { address: ValidatedDeliveryAddress; line2: string; customerAddressId: string | null };

/** The address the POS validated, else the customer's most used saved one. */
async function deliveryAddressForChange(order: Record<string, unknown>, change: FulfillmentChange): Promise<ResolvedAddress> {
  if (change.deliveryValidationToken) {
    let address;
    try {
      address = addressForOrder("delivery", change.deliveryValidationToken, String(change.deliveryAddress || "").trim());
    } catch (error) {
      throw new OrderConflictError(error instanceof Error ? error.message : "Validate the delivery address.");
    }
    if (!address) throw new OrderConflictError("Validate the delivery address.");
    return { address, line2: String(change.deliveryUnit || ""), customerAddressId: null };
  }
  const saved = !order.customer_id ? undefined : (await getSql()`
    SELECT a.id,a.line1,a.line2,a.city,a.state,a.postal_code
    FROM ordering_customer_addresses a
    WHERE a.customer_id=${String(order.customer_id)} AND a.active=TRUE
    ORDER BY (SELECT COUNT(*) FROM ordering_order_delivery_addresses used WHERE used.customer_address_id=a.id) DESC,a.is_primary DESC,a.last_used_at DESC NULLS LAST,a.created_at DESC
    LIMIT 1`)[0];
  if (!saved) throw new DeliveryAddressNeededError();
  try {
    const enteredAddress = [saved.line1, saved.line2, saved.city, saved.state, saved.postal_code].filter(Boolean).join(", ");
    const address = await validateDeliveryAddress({ enteredAddress, sessionToken: randomUUID() });
    return { address, line2: String(saved.line2 || ""), customerAddressId: String(saved.id) };
  } catch {
    throw new DeliveryAddressNeededError();
  }
}

/**
 * Switches an open order between pickup and delivery, or changes where a delivery goes,
 * and reprices it straight away. Nothing changes if the address can't be priced.
 */
export async function changeOrderFulfillment(orderId: string, business: OrderingBusiness, actor: OrderingActor, change: FulfillmentChange) {
  const sql = getSql();
  const current = (await sql`SELECT * FROM ordering_orders WHERE id=${orderId} AND business=${business}`)[0];
  if (!await orderOpenForChanges(orderId, current)) throw new OrderConflictError("This order is not open for changes.");
  const previousService = String(current.service_type);
  const addressChange = change.serviceType === "delivery" && previousService === "delivery" && Boolean(change.deliveryValidationToken);
  if (change.serviceType === previousService && !addressChange) return current;

  let deliveryFeeCents = 0, resolved: ResolvedAddress | null = null, route = null, deliveryAddress = "";
  if (change.serviceType === "delivery") {
    // An address already on the order was validated and routed then; switching back to it needs no new lookup.
    const onOrder = change.deliveryValidationToken ? undefined : (await sql`SELECT formatted_address,route_distance_miles FROM ordering_order_delivery_addresses WHERE order_id=${orderId} AND validation_status='validated' AND route_distance_miles IS NOT NULL`)[0];
    if (!onOrder) {
      resolved = await deliveryAddressForChange(current, change);
      route = await routeDeliveryAddress(resolved.address).catch(() => null);
      if (!route) throw new OrderConflictError("Could not get the driving distance for this address, so the delivery fee can't be worked out. Try again.");
    }
    deliveryAddress = onOrder ? String(onOrder.formatted_address) : String(resolved?.address.formattedAddress);
    try {
      deliveryFeeCents = (await quoteDelivery({ business, distanceMiles: onOrder ? Number(onOrder.route_distance_miles) : Number(route?.distanceMiles), merchandiseSubtotalCents: merchandiseAfterDiscounts(current) })).deliveryFeeCents;
    } catch (error) {
      throw new OrderConflictError(error instanceof Error ? error.message : "Could not calculate the delivery fee.");
    }
  }

  await withTransaction(async () => {
    const locked = (await sql`SELECT status FROM ordering_orders WHERE id=${orderId} FOR UPDATE`)[0];
    if (locked?.status !== "draft") throw new OrderConflictError("This order is not open for changes.");
    if (change.serviceType === "pickup") {
      const out = await sql`SELECT 1 FROM ordering_delivery_assignments WHERE order_id=${orderId} AND status IN('PICKED_UP','EN_ROUTE','ARRIVED') LIMIT 1`;
      if (out.length) throw new OrderConflictError("A driver already has this order. Call the driver before switching it to pickup.");
      await sql`UPDATE ordering_delivery_assignments SET status='CANCELLED',cancelled_at=NOW(),status_note='Order switched to pickup',updated_at=NOW() WHERE order_id=${orderId} AND status NOT IN('DELIVERED','RETURNED','CANCELLED')`;
    }
    if (resolved) await saveOrderDeliveryAddress({ orderId, address: resolved.address, line2: resolved.line2, customerAddressId: resolved.customerAddressId, route });
    const updated = (await sql`UPDATE ordering_orders SET service_type=${change.serviceType},delivery_fee_cents=${deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${deliveryFeeCents}-paid_cents),payment_status=CASE WHEN paid_cents<=0 THEN 'unpaid' WHEN paid_cents>=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${deliveryFeeCents}) THEN 'paid' ELSE 'partially_paid' END,version=version+1,updated_at=NOW() WHERE id=${orderId} RETURNING version`)[0];
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)VALUES(${randomUUID()},${orderId},${updated.version},'order_fulfillment_changed',${actor.type},${actor.id},${JSON.stringify({ from: previousService, to: change.serviceType, deliveryFeeCents, deliveryAddress, actorName: actor.name })}::jsonb)`;
  });
  await syncDraftTotals(orderId, business);
  const order = (await sql`SELECT * FROM ordering_orders WHERE id=${orderId}`)[0];
  const checks = await sql`SELECT id,total_cents FROM ordering_checks WHERE order_id=${orderId} ORDER BY display_sequence,id`;
  if (checks.length) {
    const otherTotal = checks.slice(1).reduce((sum, row) => sum + Number(row.total_cents), 0), primaryTotal = Math.max(0, Number(order.total_cents) - otherTotal);
    await sql`UPDATE ordering_checks SET total_cents=${primaryTotal},amount_due_cents=GREATEST(0,${primaryTotal}-paid_cents),status=CASE WHEN paid_cents=0 THEN 'open' WHEN paid_cents>=${primaryTotal} THEN 'paid' ELSE 'partially_paid' END,updated_at=NOW() WHERE id=${checks[0].id}`;
  }
  return order;
}

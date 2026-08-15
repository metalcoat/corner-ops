import { apiError, unauthorized } from "@/lib/http";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";
import { ensureOrderingDeliverySchema } from "@/lib/ordering-delivery-schema";
import { createTimedDraftOrder } from "@/lib/ordering-timed-orders";
import type { OrderTimingMode } from "@/lib/ordering-timing-core";
import { orderingActor } from "@/lib/ordering-route-auth";
import { addressForOrder, routeDeliveryAddress } from "@/lib/ordering-address";
import { saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";
import { getSql } from "@/lib/db";
import { quoteDelivery } from "@/lib/ordering-delivery";

export const runtime = "nodejs";

function readBusiness(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function readServiceType(value: unknown): ServiceType {
  if (value === "undecided" || value === "pickup" || value === "delivery" || value === "no_contact_delivery" || value === "dine_in" || value === "curbside" || value === "bar") {
    return value;
  }
  throw new Error("Unknown fulfillment type.");
}

function readTimingMode(value: unknown): OrderTimingMode {
  if (value == null || value === "asap") return "asap";
  if (value === "future") return "future";
  throw new Error("Unknown order timing mode.");
}

function readRequestedFor(value: unknown, mode: OrderTimingMode): Date | null {
  if (mode !== "future") return null;
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) throw new Error("A valid future order time is required.");
  return date;
}

function cashierOrderError(error: unknown): Response | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  const safeOrderError = /^(Choose a size|The selected size|This (item|menu item)|Menu item|Item quantity|Required modifier choices|Required combo choice|An invalid (modifier|combo)|Invalid quantity|The selected combo|A selected modifier|A valid future order time|Unknown (business|fulfillment type|order timing mode)|Invalid order item)/.test(message)
    || message.endsWith(" is currently unavailable.");
  if (!safeOrderError) return null;
  return Response.json({ error: message }, { status: 409 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const business = readBusiness(body.business);
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();

    await ensureOrderingDeliverySchema();

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Invalid order item.");
      const record = item as Record<string, unknown>;
      return {
        itemId: String(record.itemId || ""),
        variantId: record.variantId ? String(record.variantId) : null,
        quantity: Number(record.quantity || 1),
        modifierSelections: record.modifierSelections && typeof record.modifierSelections === "object"
          ? record.modifierSelections as Record<string, string[]>
          : {},
        modifierQuantities: record.modifierQuantities && typeof record.modifierQuantities === "object"
          ? record.modifierQuantities as Record<string, number>
          : {},
        modifierAmounts: record.modifierAmounts && typeof record.modifierAmounts === "object"
          ? record.modifierAmounts as Record<string, "light"|"normal"|"heavy">
          : {},
        modifierDeclines: Array.isArray(record.modifierDeclines) ? record.modifierDeclines.map(String) : [],
        pizzaToppings: Array.isArray(record.pizzaToppings)
          ? record.pizzaToppings.map((value) => {
            if (!value || typeof value !== "object") throw new Error("An invalid pizza topping was submitted.");
            const topping = value as Record<string, unknown>;
            const portion = String(topping.portion || "");
            const amount = String(topping.amount || "");
            if (!(["whole", "left_half", "right_half"] as string[]).includes(portion)
              || !(["regular", "extra", "double_extra", "triple_extra"] as string[]).includes(amount)) throw new Error("An invalid pizza topping was submitted.");
            return { modifierOptionId: String(topping.modifierOptionId || ""), portion: portion as "whole" | "left_half" | "right_half", amount: amount as "regular" | "extra" | "double_extra" | "triple_extra" };
          })
          : [],
        comboId: record.comboId ? String(record.comboId) : null,
        comboSelections: record.comboSelections && typeof record.comboSelections === "object"
          ? record.comboSelections as Record<string, string[]>
          : {},
        specialInstructions: String(record.specialInstructions || ""),
      } satisfies VariantConfiguredOrderItemInput;
    });

    const timingMode = readTimingMode(body.timingMode);
    const serviceType = readServiceType(body.serviceType);
    const enteredAddress = String(body.deliveryAddress || "");
    const customerAddressId=body.customerAddressId?String(body.customerAddressId):null;
    if(customerAddressId){const rows=await getSql()`SELECT address.id FROM ordering_customer_addresses address JOIN ordering_customers customer ON customer.id=address.customer_id WHERE address.id=${customerAddressId} AND address.customer_id=${body.customerId?String(body.customerId):null} AND address.active=TRUE AND customer.business=${business}`;if(!rows[0])return Response.json({error:"The selected customer address is no longer available."},{status:409})}
    let validatedAddress = null;
    if (enteredAddress || body.deliveryValidationToken) {
      try { validatedAddress = addressForOrder(serviceType, String(body.deliveryValidationToken || ""), enteredAddress); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Validate the delivery address." }, { status: 409 }); }
    }
    let order = await createTimedDraftOrder({
      business,
      source: "pos",
      serviceType,
      customerId: body.customerId ? String(body.customerId) : null,
      customerPhoneId: body.customerPhoneId ? String(body.customerPhoneId) : null,
      callerPhone: body.callerPhone ? String(body.callerPhone) : "",
      customerFirstName: body.customerFirstName ? String(body.customerFirstName) : "",
      customerLastName: body.customerLastName ? String(body.customerLastName) : "",
      orderOrigin: body.orderOrigin === "phone" ? "phone" : "pos",
      createdBy: actor.id,
      createdByName: actor.name,
      items,
      timingMode,
      requestedFor: readRequestedFor(body.scheduledFor, timingMode),
    });
    if (validatedAddress) {
      let route = null;
      try { route = await routeDeliveryAddress(validatedAddress); } catch { /* Routing remains optional until origin coordinates are configured. */ }
      await saveOrderDeliveryAddress({ orderId: String(order.id), address: validatedAddress, line2: String(body.deliveryUnit || ""), customerAddressId, route });
      if (route) {
        const delivery = await quoteDelivery({ business, distanceMiles: route.distanceMiles, merchandiseSubtotalCents: Number(order.subtotal_cents) });
        const rows = await getSql()`UPDATE ordering_orders SET delivery_fee_cents=${delivery.deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${delivery.deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${delivery.deliveryFeeCents}-paid_cents),updated_at=NOW() WHERE id=${order.id} RETURNING *`;
        order = rows[0] as typeof order;
      }
    }
    const promotions = await getSql()`SELECT label_snapshot label,discount_cents FROM ordering_order_promotion_applications WHERE order_id=${order.id} ORDER BY application_sequence`;
    const orderItems=await getSql()`SELECT id,sort_order FROM ordering_order_items WHERE order_id=${order.id} ORDER BY sort_order,created_at,id`;
    return Response.json({ order, promotions, orderItems }, { status: 201 });
  } catch (error) {
    return cashierOrderError(error) || apiError(error);
  }
}

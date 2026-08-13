import { apiError, unauthorized } from "@/lib/http";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";
import { ensureOrderingDeliverySchema } from "@/lib/ordering-delivery-schema";
import { createTimedDraftOrder } from "@/lib/ordering-timed-orders";
import type { OrderTimingMode } from "@/lib/ordering-timing-core";
import { orderingActor } from "@/lib/ordering-route-auth";
import { addressForOrder, routeDeliveryAddress } from "@/lib/ordering-address";
import { saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";

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
    let validatedAddress = null;
    try { validatedAddress = addressForOrder(serviceType, String(body.deliveryValidationToken || ""), enteredAddress); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Validate the delivery address." }, { status: 409 }); }
    const order = await createTimedDraftOrder({
      business,
      source: "pos",
      serviceType,
      customerId: body.customerId ? String(body.customerId) : null,
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
      await saveOrderDeliveryAddress({ orderId: String(order.id), address: validatedAddress, line2: String(body.deliveryUnit || ""), route });
    }
    return Response.json({ order }, { status: 201 });
  } catch (error) {
    return cashierOrderError(error) || apiError(error);
  }
}

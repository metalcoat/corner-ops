import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";
import { ensureOrderingDeliverySchema } from "@/lib/ordering-delivery-schema";
import { createTimedDraftOrder } from "@/lib/ordering-timed-orders";
import type { OrderTimingMode } from "@/lib/ordering-timing-core";

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

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const business = readBusiness(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

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
        comboId: record.comboId ? String(record.comboId) : null,
        comboSelections: record.comboSelections && typeof record.comboSelections === "object"
          ? record.comboSelections as Record<string, string[]>
          : {},
        specialInstructions: String(record.specialInstructions || ""),
      } satisfies VariantConfiguredOrderItemInput;
    });

    const timingMode = readTimingMode(body.timingMode);
    const order = await createTimedDraftOrder({
      business,
      source: "pos",
      serviceType: readServiceType(body.serviceType),
      customerId: body.customerId ? String(body.customerId) : null,
      callerPhone: body.callerPhone ? String(body.callerPhone) : "",
      createdBy: session.email,
      items,
      timingMode,
      requestedFor: readRequestedFor(body.scheduledFor, timingMode),
    });
    return Response.json({ order }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

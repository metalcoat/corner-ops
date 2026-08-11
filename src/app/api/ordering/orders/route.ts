import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { createDraftOrder, type ConfiguredOrderItemInput } from "@/lib/ordering-orders";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";

export const runtime = "nodejs";

function readBusiness(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function readServiceType(value: unknown): ServiceType {
  if (value === "pickup" || value === "delivery" || value === "no_contact_delivery" || value === "dine_in" || value === "curbside" || value === "bar") {
    return value;
  }
  throw new Error("Unknown fulfillment type.");
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

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Invalid order item.");
      const record = item as Record<string, unknown>;
      return {
        itemId: String(record.itemId || ""),
        quantity: Number(record.quantity || 1),
        modifierSelections: record.modifierSelections && typeof record.modifierSelections === "object"
          ? record.modifierSelections as Record<string, string[]>
          : {},
        comboId: record.comboId ? String(record.comboId) : null,
        comboSelections: record.comboSelections && typeof record.comboSelections === "object"
          ? record.comboSelections as Record<string, string[]>
          : {},
        specialInstructions: String(record.specialInstructions || ""),
      } satisfies ConfiguredOrderItemInput;
    });

    const order = await createDraftOrder({
      business,
      source: "pos",
      serviceType: readServiceType(body.serviceType),
      customerId: body.customerId ? String(body.customerId) : null,
      callerPhone: body.callerPhone ? String(body.callerPhone) : "",
      createdBy: session.email,
      items,
    });
    return Response.json({ order }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

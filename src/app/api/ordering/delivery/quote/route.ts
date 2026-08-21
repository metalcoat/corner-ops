import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { quoteDelivery } from "@/lib/ordering-delivery";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

function readBusiness(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const business = readBusiness(body.business);
    const actor=await orderingActor(business);
    if(!actor)return unauthorized();

    const managerBypassApproved = Boolean(body.managerBypassApproved);
    if (managerBypassApproved && !canManagePos(actor)) {
      return Response.json({ error: "Manager authorization is required to bypass a delivery minimum." }, { status: 403 });
    }

    const quote = await quoteDelivery({
      business,
      distanceMiles: Number(body.distanceMiles),
      merchandiseSubtotalCents: Number(body.merchandiseSubtotalCents),
      customerDeclinedUpsell: Boolean(body.customerDeclinedUpsell),
      managerBypassApproved,
    });

    return Response.json({ quote });
  } catch (error) {
    return apiError(error);
  }
}

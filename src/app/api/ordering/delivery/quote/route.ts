import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { quoteDelivery } from "@/lib/ordering-delivery";

export const runtime = "nodejs";

function readBusiness(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
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

    const managerBypassApproved = Boolean(body.managerBypassApproved);
    if (managerBypassApproved && !["Owner", "Co-Owner", "Manager"].includes(session.role)) {
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

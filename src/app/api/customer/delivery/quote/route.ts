import { isoJson } from "@/lib/timestamp-values";
import { quoteDelivery } from "@/lib/ordering-delivery";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const distanceMiles = Number(body.distanceMiles);
    const merchandiseSubtotalCents = Math.trunc(Number(body.merchandiseSubtotalCents));
    if (!Number.isFinite(distanceMiles) || distanceMiles < 0) return isoJson({ error: "A valid delivery distance is required." }, { status: 400 });
    if (!Number.isSafeInteger(merchandiseSubtotalCents) || merchandiseSubtotalCents < 0) return isoJson({ error: "A valid merchandise subtotal is required." }, { status: 400 });
    const quote = await quoteDelivery({
      business: "Corner Deli",
      distanceMiles,
      merchandiseSubtotalCents,
      customerDeclinedUpsell: Boolean(body.customerDeclinedUpsell),
      managerBypassApproved: false,
    });
    return isoJson({ quote });
  } catch (error) {
    console.error(error);
    return isoJson({ error: "A delivery quote could not be completed." }, { status: 500 });
  }
}

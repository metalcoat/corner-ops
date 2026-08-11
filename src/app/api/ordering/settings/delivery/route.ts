import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { getDeliveryPricingSettings, saveDeliveryPricingSettings } from "@/lib/ordering-delivery";

export const runtime = "nodejs";

function readBusiness(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function requirePricingOwner(role: string): void {
  if (role !== "Owner" && role !== "Co-Owner") {
    throw new Error("Only an owner or co-owner can change delivery pricing and tax settings.");
  }
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const url = new URL(request.url);
    const business = readBusiness(url.searchParams.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json({ settings: await getDeliveryPricingSettings(business) });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePricingOwner(session.role);
    const body = await request.json() as Record<string, unknown>;
    const business = readBusiness(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const rawBands = Array.isArray(body.feeBands) ? body.feeBands : [];
    const current = await getDeliveryPricingSettings(business);
    const settings = await saveDeliveryPricingSettings({
      business,
      enabled: body.enabled == null ? current.enabled : Boolean(body.enabled),
      minimumOrderCents: body.minimumOrderCents == null ? current.minimumOrderCents : Number(body.minimumOrderCents),
      offerUpsellBeforeShortfallFee: body.offerUpsellBeforeShortfallFee == null
        ? current.offerUpsellBeforeShortfallFee
        : Boolean(body.offerUpsellBeforeShortfallFee),
      allowShortfallFee: body.allowShortfallFee == null ? current.allowShortfallFee : Boolean(body.allowShortfallFee),
      shortfallFeeLabel: body.shortfallFeeLabel == null ? current.shortfallFeeLabel : String(body.shortfallFeeLabel),
      allowManagerBypass: body.allowManagerBypass == null ? current.allowManagerBypass : Boolean(body.allowManagerBypass),
      notifyManagementOnBypass: body.notifyManagementOnBypass == null
        ? current.notifyManagementOnBypass
        : Boolean(body.notifyManagementOnBypass),
      maxDistanceMiles: body.maxDistanceMiles == null ? current.maxDistanceMiles : Number(body.maxDistanceMiles),
      pricesIncludeTax: body.pricesIncludeTax == null ? current.pricesIncludeTax : Boolean(body.pricesIncludeTax),
      taxRateBps: body.taxRateBps == null ? current.taxRateBps : Number(body.taxRateBps),
      taxRateConfigured: true,
      deliveryFeeTaxable: body.deliveryFeeTaxable == null ? current.deliveryFeeTaxable : Boolean(body.deliveryFeeTaxable),
      minimumAdjustmentTaxable: body.minimumAdjustmentTaxable == null
        ? current.minimumAdjustmentTaxable
        : Boolean(body.minimumAdjustmentTaxable),
      feeBands: rawBands.length
        ? rawBands.map((value) => {
            const band = value as Record<string, unknown>;
            return {
              minMilesExclusive: Number(band.minMilesExclusive),
              maxMilesInclusive: Number(band.maxMilesInclusive),
              feeCents: Number(band.feeCents),
            };
          })
        : current.feeBands,
    }, session.email);

    return Response.json({ settings });
  } catch (error) {
    return apiError(error);
  }
}

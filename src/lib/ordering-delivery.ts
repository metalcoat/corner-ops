import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingDeliverySchema } from "@/lib/ordering-delivery-schema";
import { evaluateDeliveryMinimum, resolveDeliveryFeeCents, type DeliveryFeeBand } from "@/lib/ordering-delivery-core";

export type DeliveryPricingSettings = {
  business: OrderingBusiness;
  enabled: boolean;
  minimumOrderCents: number;
  offerUpsellBeforeShortfallFee: boolean;
  allowShortfallFee: boolean;
  shortfallFeeLabel: string;
  allowManagerBypass: boolean;
  notifyManagementOnBypass: boolean;
  maxDistanceMiles: number | null;
  pricesIncludeTax: boolean;
  taxRateBps: number;
  taxRateConfigured: boolean;
  deliveryFeeTaxable: boolean;
  minimumAdjustmentTaxable: boolean;
  feeBands: DeliveryFeeBand[];
};

type PolicyRow = {
  enabled: boolean;
  minimum_order_cents: number;
  offer_upsell_before_shortfall_fee: boolean;
  allow_shortfall_fee: boolean;
  shortfall_fee_label: string;
  allow_manager_bypass: boolean;
  notify_management_on_bypass: boolean;
  max_distance_miles: number | string | null;
  prices_include_tax: boolean;
  tax_rate_bps: number;
  tax_rate_configured: boolean;
  delivery_fee_taxable: boolean;
  minimum_adjustment_taxable: boolean;
};

type BandRow = {
  min_miles: number | string;
  max_miles: number | string;
  fee_cents: number;
};

export async function getDeliveryPricingSettings(business: OrderingBusiness): Promise<DeliveryPricingSettings> {
  await ensureOrderingDeliverySchema();
  const sql = getSql();
  const policies = (await sql`
    SELECT
      policy.enabled,
      policy.minimum_order_cents,
      policy.offer_upsell_before_shortfall_fee,
      policy.allow_shortfall_fee,
      policy.shortfall_fee_label,
      policy.allow_manager_bypass,
      policy.notify_management_on_bypass,
      policy.max_distance_miles,
      tax.prices_include_tax,
      tax.tax_rate_bps,
      tax.tax_rate_configured,
      tax.delivery_fee_taxable,
      tax.minimum_adjustment_taxable
    FROM ordering_delivery_policies policy
    JOIN ordering_business_tax_settings tax ON tax.business = policy.business
    WHERE policy.business = ${business}
    LIMIT 1
  `) as PolicyRow[];

  const policy = policies[0];
  const bands = (await sql`
    SELECT min_miles, max_miles, fee_cents
    FROM ordering_delivery_fee_bands
    WHERE business = ${business} AND active = TRUE
    ORDER BY sort_order, max_miles
  `) as BandRow[];

  return {
    business,
    enabled: Boolean(policy?.enabled),
    minimumOrderCents: Number(policy?.minimum_order_cents || 0),
    offerUpsellBeforeShortfallFee: policy?.offer_upsell_before_shortfall_fee !== false,
    allowShortfallFee: policy?.allow_shortfall_fee !== false,
    shortfallFeeLabel: policy?.shortfall_fee_label || "Minimum order adjustment",
    allowManagerBypass: policy?.allow_manager_bypass !== false,
    notifyManagementOnBypass: policy?.notify_management_on_bypass !== false,
    maxDistanceMiles: policy?.max_distance_miles == null ? null : Number(policy.max_distance_miles),
    pricesIncludeTax: policy?.prices_include_tax !== false,
    taxRateBps: Number(policy?.tax_rate_bps || 0),
    taxRateConfigured: Boolean(policy?.tax_rate_configured),
    deliveryFeeTaxable: policy?.delivery_fee_taxable !== false,
    minimumAdjustmentTaxable: policy?.minimum_adjustment_taxable !== false,
    feeBands: bands.map((band) => ({
      minMilesExclusive: Number(band.min_miles),
      maxMilesInclusive: Number(band.max_miles),
      feeCents: Number(band.fee_cents),
    })),
  };
}

export async function quoteDelivery(input: {
  business: OrderingBusiness;
  distanceMiles: number;
  merchandiseSubtotalCents: number;
  customerDeclinedUpsell?: boolean;
  managerBypassApproved?: boolean;
}) {
  const settings = await getDeliveryPricingSettings(input.business);
  if (!settings.enabled) throw new Error("Delivery is not enabled for this business.");
  if (settings.maxDistanceMiles != null && input.distanceMiles > settings.maxDistanceMiles) {
    throw new Error(`Delivery address is outside the configured ${settings.maxDistanceMiles}-mile delivery area.`);
  }

  const deliveryFeeCents = resolveDeliveryFeeCents(input.distanceMiles, settings.feeBands);
  if (deliveryFeeCents == null) throw new Error("No delivery fee is configured for this distance.");

  const minimum = evaluateDeliveryMinimum({
    merchandiseSubtotalCents: input.merchandiseSubtotalCents,
    minimumOrderCents: settings.minimumOrderCents,
    customerDeclinedUpsell: input.customerDeclinedUpsell,
    allowShortfallFee: settings.allowShortfallFee,
    managerBypassApproved: input.managerBypassApproved,
  });

  if (minimum.resolution === "manager_bypass_approved" && !settings.allowManagerBypass) {
    throw new Error("Delivery minimum bypasses are disabled for this business.");
  }

  return { settings, deliveryFeeCents, minimum };
}

export async function recordDeliveryMinimumResolution(input: {
  orderId: string;
  business: OrderingBusiness;
  minimumOrderCents: number;
  merchandiseSubtotalCents: number;
  shortfallCents: number;
  resolutionType: "shortfall_fee" | "bypass";
  adjustmentFeeCents: number;
  upsellOffered: boolean;
  customerDeclinedUpsell: boolean;
  actorType: "ai" | "employee" | "web" | "system";
  actorId: string;
  approvedBy?: string;
  reason?: string;
}): Promise<{ exceptionId: string; alertId: string | null }> {
  await ensureOrderingDeliverySchema();
  const sql = getSql();
  const exceptionId = randomUUID();

  await sql`
    INSERT INTO ordering_delivery_minimum_exceptions (
      id, order_id, business, resolution_type, minimum_order_cents,
      merchandise_subtotal_cents, shortfall_cents, adjustment_fee_cents,
      upsell_offered, customer_declined_upsell, actor_type, actor_id, approved_by, reason
    ) VALUES (
      ${exceptionId}, ${input.orderId}, ${input.business}, ${input.resolutionType}, ${Math.max(0, Math.trunc(input.minimumOrderCents))},
      ${Math.max(0, Math.trunc(input.merchandiseSubtotalCents))}, ${Math.max(0, Math.trunc(input.shortfallCents))}, ${Math.max(0, Math.trunc(input.adjustmentFeeCents))},
      ${input.upsellOffered}, ${input.customerDeclinedUpsell}, ${input.actorType}, ${input.actorId}, ${input.approvedBy || ""}, ${input.reason || ""}
    )
  `;

  let alertId: string | null = null;
  if (input.resolutionType === "bypass") {
    const settings = await getDeliveryPricingSettings(input.business);
    if (settings.notifyManagementOnBypass) {
      alertId = randomUUID();
      await sql`
        INSERT INTO ordering_management_alerts (
          id, business, order_id, alert_type, severity, title, message, created_by, details
        ) VALUES (
          ${alertId}, ${input.business}, ${input.orderId}, 'delivery_minimum_bypass', 'warning',
          'Delivery minimum bypassed',
          ${`A delivery order was allowed below the configured minimum by $${(input.shortfallCents / 100).toFixed(2)}.`},
          ${input.actorId || input.approvedBy || "system"},
          CAST(${JSON.stringify({
            minimumOrderCents: input.minimumOrderCents,
            merchandiseSubtotalCents: input.merchandiseSubtotalCents,
            shortfallCents: input.shortfallCents,
            approvedBy: input.approvedBy || "",
            reason: input.reason || "",
          })} AS jsonb)
        )
      `;
    }
  }

  return { exceptionId, alertId };
}

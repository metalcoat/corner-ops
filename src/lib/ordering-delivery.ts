import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingDeliverySchema } from "@/lib/ordering-delivery-schema";
import { evaluateDeliveryMinimum, resolveDeliveryFeeCents, type DeliveryFeeBand } from "@/lib/ordering-delivery-core";

export type DeliveryPricingSettings = {
  business: OrderingBusiness;
  enabled: boolean;
  minimumOrderCents: number;
  deliveryFeeCountsTowardMinimum: boolean;
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
  minimum_basis: string;
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

function normalizeBands(bands: DeliveryFeeBand[]): DeliveryFeeBand[] {
  if (!bands.length) throw new Error("At least one delivery fee band is required.");
  const normalized = bands.map((band) => ({
    minMilesExclusive: Number(band.minMilesExclusive),
    maxMilesInclusive: Number(band.maxMilesInclusive),
    feeCents: Math.trunc(Number(band.feeCents)),
  })).sort((a, b) => a.maxMilesInclusive - b.maxMilesInclusive);

  for (const [index, band] of normalized.entries()) {
    if (!Number.isFinite(band.minMilesExclusive) || !Number.isFinite(band.maxMilesInclusive)) {
      throw new Error("Delivery mileage bands must contain valid numbers.");
    }
    if (band.minMilesExclusive < 0 || band.maxMilesInclusive <= band.minMilesExclusive) {
      throw new Error("Each delivery mileage band must have an increasing positive range.");
    }
    if (!Number.isSafeInteger(band.feeCents) || band.feeCents < 0) {
      throw new Error("Delivery fees must be non-negative whole cents.");
    }
    if (index === 0 && band.minMilesExclusive !== 0) {
      throw new Error("The first delivery mileage band must begin at 0 miles.");
    }
    if (index > 0 && band.minMilesExclusive !== normalized[index - 1].maxMilesInclusive) {
      throw new Error("Delivery mileage bands must be contiguous without gaps or overlaps.");
    }
  }

  return normalized;
}

export async function getDeliveryPricingSettings(business: OrderingBusiness): Promise<DeliveryPricingSettings> {
  await ensureOrderingDeliverySchema();
  const sql = getSql();
  const policies = (await sql`
    SELECT
      policy.enabled,
      policy.minimum_order_cents,
      policy.minimum_basis,
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
    deliveryFeeCountsTowardMinimum: policy?.minimum_basis === "order_total_including_delivery_fee",
    offerUpsellBeforeShortfallFee: policy?.offer_upsell_before_shortfall_fee !== false,
    allowShortfallFee: policy?.allow_shortfall_fee !== false,
    shortfallFeeLabel: policy?.shortfall_fee_label || "Round up to delivery minimum",
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

export async function saveDeliveryPricingSettings(input: DeliveryPricingSettings, updatedBy: string): Promise<DeliveryPricingSettings> {
  await ensureOrderingDeliverySchema();
  const sql = getSql();
  const minimumOrderCents = Math.max(0, Math.trunc(input.minimumOrderCents));
  const taxRateBps = Math.max(0, Math.trunc(input.taxRateBps));
  if (taxRateBps > 10_000) throw new Error("Tax rate cannot exceed 100%.");
  const bands = normalizeBands(input.feeBands);
  const maxDistanceMiles = input.maxDistanceMiles == null
    ? bands[bands.length - 1].maxMilesInclusive
    : Number(input.maxDistanceMiles);
  if (!Number.isFinite(maxDistanceMiles) || maxDistanceMiles <= 0) throw new Error("Maximum delivery distance must be greater than zero.");
  if (bands[bands.length - 1].maxMilesInclusive !== maxDistanceMiles) {
    throw new Error("The last delivery fee band must end at the configured maximum delivery distance.");
  }

  await sql`
    UPDATE ordering_business_tax_settings
    SET prices_include_tax = ${input.pricesIncludeTax},
        tax_rate_bps = ${taxRateBps},
        tax_rate_configured = TRUE,
        delivery_fee_taxable = ${input.deliveryFeeTaxable},
        minimum_adjustment_taxable = ${input.minimumAdjustmentTaxable},
        updated_by = ${updatedBy},
        updated_at = NOW()
    WHERE business = ${input.business}
  `;

  const minimumBasis = input.deliveryFeeCountsTowardMinimum
    ? "order_total_including_delivery_fee"
    : "merchandise_after_discounts";

  await sql`
    INSERT INTO ordering_delivery_policies (
      business, enabled, minimum_order_cents, minimum_basis, offer_upsell_before_shortfall_fee,
      allow_shortfall_fee, shortfall_fee_label, allow_manager_bypass,
      notify_management_on_bypass, max_distance_miles, updated_by
    ) VALUES (
      ${input.business}, ${input.enabled}, ${minimumOrderCents}, ${minimumBasis}, ${input.offerUpsellBeforeShortfallFee},
      ${input.allowShortfallFee}, ${input.shortfallFeeLabel || "Round up to delivery minimum"}, ${input.allowManagerBypass},
      ${input.notifyManagementOnBypass}, ${maxDistanceMiles}, ${updatedBy}
    )
    ON CONFLICT (business) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      minimum_order_cents = EXCLUDED.minimum_order_cents,
      minimum_basis = EXCLUDED.minimum_basis,
      offer_upsell_before_shortfall_fee = EXCLUDED.offer_upsell_before_shortfall_fee,
      allow_shortfall_fee = EXCLUDED.allow_shortfall_fee,
      shortfall_fee_label = EXCLUDED.shortfall_fee_label,
      allow_manager_bypass = EXCLUDED.allow_manager_bypass,
      notify_management_on_bypass = EXCLUDED.notify_management_on_bypass,
      max_distance_miles = EXCLUDED.max_distance_miles,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
  `;

  await sql`UPDATE ordering_delivery_fee_bands SET active = FALSE, updated_by = ${updatedBy}, updated_at = NOW() WHERE business = ${input.business}`;
  for (const [index, band] of bands.entries()) {
    await sql`
      INSERT INTO ordering_delivery_fee_bands (
        id, business, min_miles, max_miles, fee_cents, active, sort_order, updated_by
      ) VALUES (
        ${randomUUID()}, ${input.business}, ${band.minMilesExclusive}, ${band.maxMilesInclusive}, ${band.feeCents}, TRUE, ${(index + 1) * 10}, ${updatedBy}
      )
      ON CONFLICT (business, min_miles, max_miles) DO UPDATE SET
        fee_cents = EXCLUDED.fee_cents,
        active = TRUE,
        sort_order = EXCLUDED.sort_order,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
    `;
  }

  return getDeliveryPricingSettings(input.business);
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
    deliveryFeeCents,
    deliveryFeeCountsTowardMinimum: settings.deliveryFeeCountsTowardMinimum,
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

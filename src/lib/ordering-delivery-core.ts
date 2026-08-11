import type { ServiceType } from "@/lib/ordering-core";

export type DeliveryFeeBand = {
  minMilesExclusive: number;
  maxMilesInclusive: number;
  feeCents: number;
};

export type DeliveryMinimumResolution =
  | "meets_minimum"
  | "offer_upsell"
  | "apply_shortfall_fee"
  | "manager_bypass_required"
  | "manager_bypass_approved";

export type DeliveryMinimumEvaluation = {
  minimumOrderCents: number;
  merchandiseSubtotalCents: number;
  shortfallCents: number;
  resolution: DeliveryMinimumResolution;
  adjustmentFeeCents: number;
  managementAlertRequired: boolean;
};

export type DeliveryConfirmationIssue = {
  code:
    | "delivery_distance_required"
    | "delivery_fee_not_configured"
    | "delivery_minimum_not_met"
    | "delivery_minimum_resolution_required";
  message: string;
  shortfallCents?: number;
};

export function isDeliveryServiceType(serviceType: ServiceType): boolean {
  return serviceType === "delivery" || serviceType === "no_contact_delivery";
}

export function resolveDeliveryFeeCents(distanceMiles: number, bands: DeliveryFeeBand[]): number | null {
  if (!Number.isFinite(distanceMiles) || distanceMiles < 0) throw new Error("Delivery distance must be zero or greater.");

  const sorted = [...bands].sort((a, b) => a.maxMilesInclusive - b.maxMilesInclusive);
  const match = sorted.find((band) =>
    distanceMiles > band.minMilesExclusive && distanceMiles <= band.maxMilesInclusive,
  );

  if (distanceMiles === 0) {
    const zeroBand = sorted.find((band) => band.minMilesExclusive <= 0 && band.maxMilesInclusive >= 0);
    return zeroBand?.feeCents ?? null;
  }

  return match?.feeCents ?? null;
}

/**
 * Delivery minimums are based on merchandise, not the delivery charge itself.
 * The normal path is to offer useful add-ons first. If the customer declines,
 * policy may add an explicit minimum-order adjustment equal to the shortfall.
 * A true waiver/bypass is separate and always becomes a management-visible exception.
 */
export function evaluateDeliveryMinimum(input: {
  merchandiseSubtotalCents: number;
  minimumOrderCents: number;
  customerDeclinedUpsell?: boolean;
  allowShortfallFee?: boolean;
  managerBypassApproved?: boolean;
}): DeliveryMinimumEvaluation {
  const subtotal = Math.max(0, Math.trunc(input.merchandiseSubtotalCents));
  const minimum = Math.max(0, Math.trunc(input.minimumOrderCents));
  const shortfall = Math.max(0, minimum - subtotal);

  if (shortfall === 0) {
    return {
      minimumOrderCents: minimum,
      merchandiseSubtotalCents: subtotal,
      shortfallCents: 0,
      resolution: "meets_minimum",
      adjustmentFeeCents: 0,
      managementAlertRequired: false,
    };
  }

  if (input.managerBypassApproved) {
    return {
      minimumOrderCents: minimum,
      merchandiseSubtotalCents: subtotal,
      shortfallCents: shortfall,
      resolution: "manager_bypass_approved",
      adjustmentFeeCents: 0,
      managementAlertRequired: true,
    };
  }

  if (!input.customerDeclinedUpsell) {
    return {
      minimumOrderCents: minimum,
      merchandiseSubtotalCents: subtotal,
      shortfallCents: shortfall,
      resolution: "offer_upsell",
      adjustmentFeeCents: 0,
      managementAlertRequired: false,
    };
  }

  if (input.allowShortfallFee !== false) {
    return {
      minimumOrderCents: minimum,
      merchandiseSubtotalCents: subtotal,
      shortfallCents: shortfall,
      resolution: "apply_shortfall_fee",
      adjustmentFeeCents: shortfall,
      managementAlertRequired: false,
    };
  }

  return {
    minimumOrderCents: minimum,
    merchandiseSubtotalCents: subtotal,
    shortfallCents: shortfall,
    resolution: "manager_bypass_required",
    adjustmentFeeCents: 0,
    managementAlertRequired: true,
  };
}

/**
 * Server-side confirmation gate used by every channel. UI prompts may differ,
 * but web, AI phone ordering, and employee-entered phone delivery orders all
 * have to satisfy the same distance/minimum decision before confirmation.
 */
export function validateDeliveryForConfirmation(input: {
  serviceType: ServiceType;
  distanceMiles: number | null;
  deliveryFeeCents: number | null;
  merchandiseSubtotalCents: number;
  minimumOrderCents: number;
  minimumAdjustmentCents: number;
  minimumBypassApproved: boolean;
}): DeliveryConfirmationIssue[] {
  if (!isDeliveryServiceType(input.serviceType)) return [];

  const issues: DeliveryConfirmationIssue[] = [];
  if (input.distanceMiles == null || !Number.isFinite(input.distanceMiles) || input.distanceMiles < 0) {
    issues.push({
      code: "delivery_distance_required",
      message: "A delivery distance must be resolved before this order can be confirmed.",
    });
  }

  if (input.deliveryFeeCents == null || input.deliveryFeeCents < 0) {
    issues.push({
      code: "delivery_fee_not_configured",
      message: "A configured delivery fee must be resolved before this order can be confirmed.",
    });
  }

  const subtotal = Math.max(0, Math.trunc(input.merchandiseSubtotalCents));
  const minimum = Math.max(0, Math.trunc(input.minimumOrderCents));
  const shortfall = Math.max(0, minimum - subtotal);
  if (shortfall > 0 && !input.minimumBypassApproved) {
    if (Math.max(0, Math.trunc(input.minimumAdjustmentCents)) < shortfall) {
      issues.push({
        code: "delivery_minimum_not_met",
        message: "The delivery merchandise minimum has not been met or resolved.",
        shortfallCents: shortfall,
      });
    }
  }

  if (shortfall > 0 && input.minimumBypassApproved && input.minimumAdjustmentCents > 0) {
    issues.push({
      code: "delivery_minimum_resolution_required",
      message: "A delivery minimum must use either the shortfall fee or a manager bypass, not both.",
      shortfallCents: shortfall,
    });
  }

  return issues;
}

/**
 * Extracts the tax already embedded in an inclusive/gross price. A gross price
 * of 108.00 at 8% contains 8.00 of tax. Historical orders should snapshot the
 * rate used so changing the business tax setting never rewrites old sales.
 */
export function calculateIncludedTaxCents(grossTaxableCents: number, taxRateBps: number): number {
  const gross = Math.max(0, Math.trunc(grossTaxableCents));
  const rate = Math.max(0, Math.trunc(taxRateBps));
  if (rate === 0 || gross === 0) return 0;
  return Math.round((gross * rate) / (10_000 + rate));
}

export function calculatePreTaxCentsFromInclusivePrice(grossTaxableCents: number, taxRateBps: number): number {
  const gross = Math.max(0, Math.trunc(grossTaxableCents));
  return Math.max(0, gross - calculateIncludedTaxCents(gross, taxRateBps));
}

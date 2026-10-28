// A reward can name a "cap" variant: the reward takes off at most that variant's
// current price, so a pricier eligible item (Jumbo Thick against a free Jumbo
// Thin) is redeemable and the customer pays only the difference.
export function loyaltyBaseDiscount(unitPriceCents: number, capCents: number | null): number {
  const price = Math.max(0, Math.trunc(unitPriceCents));
  return capCents == null ? price : Math.min(price, Math.max(0, Math.trunc(capCents)));
}

export type LoyaltyUpgrade = { variantId: string; name: string; extraCents: number };

// Upgrade hints for the order screens: every other reward variant that costs more than the cap.
export function loyaltyUpgrades(capCents: number | null, capVariantId: string | null | undefined, variants: Array<{ id: string; name: string; priceCents: number }>): LoyaltyUpgrade[] {
  if (capCents == null || !capVariantId) return [];
  return variants
    .filter((variant) => variant.id !== capVariantId && variant.priceCents > capCents)
    .map((variant) => ({ variantId: variant.id, name: variant.name, extraCents: variant.priceCents - capCents }));
}

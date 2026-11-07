/**
 * Employee drinks are sold at cost: (cost + bottle deposit) plus sales tax, rounded UP to the next
 * $0.25. POS prices include tax, so that rounded amount is what the employee pays.
 * Example (2026-11-06): 20 oz costs $1.29 + $0.05 deposit = $1.34; with 8% tax $1.447 → $1.50.
 */
export function employeeDrinkPriceCents(costCents: number, depositCents: number, taxRateBps: number): number {
  const base = Math.max(0, Math.round(costCents)) + Math.max(0, Math.round(depositCents));
  if (!base) return 0;
  // Whole-number math: base × (1 + rate) in hundredths of a basis point, then up to a multiple of 25 cents.
  const scaled = base * (10_000 + Math.max(0, Math.round(taxRateBps)));
  return Math.ceil(scaled / (25 * 10_000)) * 25;
}

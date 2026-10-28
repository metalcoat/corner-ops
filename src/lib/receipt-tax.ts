// Customer receipts show the sales tax that's inside tax-included prices on its own
// line, as New York requires (TSB-H-81(56)S). Pure helpers so receipts and tests share them.

/** Tax included in a tax-inclusive amount, rounded to the cent: amount × rate ÷ (1 + rate). */
export function includedTax(grossCents: number, rateBps: number) {
  if (grossCents <= 0 || rateBps <= 0) return 0;
  return Math.round((grossCents * rateBps) / (10_000 + rateBps));
}

export function receiptTaxLine(taxCents: number) {
  return `Sales tax included: $${(Math.max(0, taxCents) / 100).toFixed(2)}`;
}

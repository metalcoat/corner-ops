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

export type ReceiptBreakdown = {
  /** Everything taxed (food after discounts, plus a taxable delivery fee) less its tax. */
  beforeTaxCents: number;
  taxCents: number;
  rateBps: number;
  /** A delivery fee the store doesn't tax, shown on its own line; 0 when taxed or none. */
  untaxedFeeCents: number;
  tipCents: number;
  totalCents: number;
};

/**
 * Splits a tax-included order total for the receipt. The lines always add up to the
 * order total to the cent: before-tax is what's left after the tax, tip and any untaxed fee.
 */
export function receiptBreakdown(input: { totalCents: number; tipCents: number; deliveryFeeCents: number; deliveryFeeTaxable: boolean; taxCents: number; rateBps: number }): ReceiptBreakdown {
  const totalCents = Math.max(0, Math.round(input.totalCents));
  const tipCents = Math.max(0, Math.round(input.tipCents));
  const untaxedFeeCents = input.deliveryFeeTaxable ? 0 : Math.max(0, Math.round(input.deliveryFeeCents));
  const taxCents = Math.max(0, Math.min(Math.round(input.taxCents), totalCents - tipCents - untaxedFeeCents));
  return { beforeTaxCents: totalCents - tipCents - untaxedFeeCents - taxCents, taxCents, rateBps: input.rateBps, untaxedFeeCents, tipCents, totalCents };
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const taxRateLabel = (rateBps: number) => `${Number((rateBps / 100).toFixed(3))}%`;

/** Receipt lines as [label, amount] pairs, in order. */
export function receiptBreakdownRows(b: ReceiptBreakdown): [string, string][] {
  return [
    ["Subtotal before tax", dollars(b.beforeTaxCents)],
    [`Sales tax (${taxRateLabel(b.rateBps)})`, dollars(b.taxCents)],
    ...(b.untaxedFeeCents ? [["Delivery fee (not taxed)", dollars(b.untaxedFeeCents)] as [string, string]] : []),
    ...(b.tipCents ? [["Tip", dollars(b.tipCents)] as [string, string]] : []),
    ["Total (tax included)", dollars(b.totalCents)],
  ];
}

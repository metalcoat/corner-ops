import assert from "node:assert/strict";
import test from "node:test";
import { includedTax, receiptTaxLine } from "../src/lib/receipt-tax";

test("receipt tax: tax inside a tax-included price at 8%", () => {
  assert.equal(includedTax(1080, 800), 80);
  assert.equal(includedTax(500, 800), 37);
  assert.equal(includedTax(2160, 800), 160);
  assert.equal(includedTax(0, 800), 0);
  assert.equal(includedTax(1000, 0), 0);
});

test("receipt tax: the separate receipt line", () => {
  assert.equal(receiptTaxLine(80), "Sales tax included: $0.80");
  assert.equal(receiptTaxLine(0), "Sales tax included: $0.00");
});

import { receiptBreakdown, receiptBreakdownRows } from "../src/lib/receipt-tax";

test("receipt tax: before-tax, tax, tip and untaxed fee add up to the total to the cent", () => {
  const taxed = receiptBreakdown({ totalCents: 2744, tipCents: 500, deliveryFeeCents: 300, deliveryFeeTaxable: true, taxCents: 166, rateBps: 800 });
  assert.deepEqual(taxed, { beforeTaxCents: 2078, taxCents: 166, rateBps: 800, untaxedFeeCents: 0, tipCents: 500, totalCents: 2744 });
  assert.deepEqual(receiptBreakdownRows(taxed), [["Subtotal before tax", "$20.78"], ["Sales tax (8%)", "$1.66"], ["Tip", "$5.00"], ["Total (tax included)", "$27.44"]]);
  const untaxed = receiptBreakdown({ totalCents: 2244, tipCents: 0, deliveryFeeCents: 300, deliveryFeeTaxable: false, taxCents: 144, rateBps: 800 });
  assert.equal(untaxed.beforeTaxCents + untaxed.taxCents + untaxed.untaxedFeeCents + untaxed.tipCents, 2244);
  assert.deepEqual(receiptBreakdownRows(untaxed)[2], ["Delivery fee (not taxed)", "$3.00"]);
  assert.equal(receiptBreakdownRows(receiptBreakdown({ totalCents: 1000, tipCents: 0, deliveryFeeCents: 0, deliveryFeeTaxable: true, taxCents: 74, rateBps: 875 }))[1][0], "Sales tax (8.75%)");
});

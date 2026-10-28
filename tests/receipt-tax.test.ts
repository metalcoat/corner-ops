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

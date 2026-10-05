import test from "node:test";
import assert from "node:assert/strict";
import { parseGuide, parseSize, splitRow } from "../src/lib/supplier-order-guide.js";

test("pack sizes the way suppliers write them", () => {
  assert.deepEqual(parseSize("5 LB"), { quantity: 5, unit: "lb" });
  assert.deepEqual(parseSize("5#"), { quantity: 5, unit: "lb" });
  assert.deepEqual(parseSize("4/5 LB"), { quantity: 20, unit: "lb" });
  assert.deepEqual(parseSize("12/16 OZ"), { quantity: 192, unit: "oz" });
  assert.deepEqual(parseSize("1000 CT"), { quantity: 1000, unit: "each" });
  assert.deepEqual(parseSize("6/#10"), { quantity: 6, unit: "each" });
  assert.deepEqual(parseSize("1/2 GAL"), { quantity: 0.5, unit: "gal" });
  assert.deepEqual(parseSize("4"), { quantity: 4, unit: "" });
  assert.equal(parseSize("assorted"), null);
});

test("quoted CSV cells keep their commas", () => {
  assert.deepEqual(splitRow('"Turkey, oven roasted",4/5 LB,"$84.50"', ","), ["Turkey, oven roasted", "4/5 LB", "$84.50"]);
});

test("Sysco-style export with separate Pack and Size columns", () => {
  const csv = 'SUPC,Pack,Size,Brand,Description,Case Price\n4521187,4,5 LB,BRDHEAD,"TURKEY BREAST OVEN RSTD",84.50\n7781230,1,1000 CT,SYS CLS,CUP DELI 16 OZ,61.99\nbad,,,,,';
  const { products, skipped } = parseGuide(csv);
  assert.equal(products.length, 2);
  assert.deepEqual(products[0], { sku: "4521187", description: "TURKEY BREAST OVEN RSTD", brand: "BRDHEAD", category: "", packQuantity: 20, packUnit: "lb", priceCents: 8450 });
  assert.equal(products[1].packQuantity, 1000);
  assert.equal(products[1].packUnit, "each");
  assert.equal(skipped.length, 1);
});

test("one pack/size cell, unit price only, tabs", () => {
  const tsv = "Item #\tProduct Description\tPack/Size\tUnit Price\n99\tChicken tenders breaded 3-4 oz\t4/5 LB\t3.10";
  const [product] = parseGuide(tsv).products;
  assert.equal(product.packQuantity, 20);
  assert.equal(product.priceCents, 6200);
});

test("header-less paste in either short form", () => {
  const { products } = parseGuide("Deli cups 16 oz, 1000, each, 61.99, 42\nTurkey breast, 4/5 LB, 84.50, 4521187");
  assert.deepEqual(products.map((p) => [p.description, p.packQuantity, p.packUnit, p.priceCents, p.sku]), [
    ["Deli cups 16 oz", 1000, "each", 6199, "42"],
    ["Turkey breast", 20, "lb", 8450, "4521187"],
  ]);
});

test("US Foods pack notation: nested packs, ranges, averages", () => {
  assert.deepEqual(parseSize("3/2/8.3 LBA"), { quantity: 49.8, unit: "lb" });
  assert.deepEqual(parseSize("2/9-10 LBA"), { quantity: 19, unit: "lb" });
  assert.deepEqual(parseSize("4/.5 GA"), { quantity: 2, unit: "gal" });
  assert.deepEqual(parseSize("4/13/1.25#A"), { quantity: 65, unit: "lb" });
  assert.deepEqual(parseSize("2/5 LBA+"), { quantity: 10, unit: "lb" });
  assert.deepEqual(parseSize("2/8/10.75 OZ"), { quantity: 172, unit: "oz" });
  assert.deepEqual(parseSize("18/12/1.3 OZ"), { quantity: 280.8, unit: "oz" });
  assert.deepEqual(parseSize("2/80/1 OZ"), { quantity: 160, unit: "oz" });
  // Existing readings are unchanged.
  assert.deepEqual(parseSize("1/2 GAL"), { quantity: 0.5, unit: "gal" });
  assert.deepEqual(parseSize("4/5 LB"), { quantity: 20, unit: "lb" });
});

test("PFG count packs with no weight unit", () => {
  assert.deepEqual(parseSize("25/Cnt"), { quantity: 25, unit: "each" });
  assert.deepEqual(parseSize("12/500"), { quantity: 6000, unit: "each" });
  assert.deepEqual(parseSize("1/1000"), { quantity: 1000, unit: "each" });
  assert.deepEqual(parseSize("1/18-24"), { quantity: 21, unit: "each" });
  assert.equal(parseSize("8/13.37"), null);
  assert.deepEqual(parseSize("1/2 GAL"), { quantity: 0.5, unit: "gal" });
});

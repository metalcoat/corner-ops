import test from "node:test";
import assert from "node:assert/strict";
import { dedupeProducts, extractProducts, productsToCsv } from "../src/lib/supplier-web-extract.js";
import { parseGuide } from "../src/lib/supplier-order-guide.js";

test("finds products in a nested order-guide response (pack + size, case price)", () => {
  const response = {
    data: {
      list: { id: "L1", name: "Main order guide", updated: "2026-10-01" },
      groups: [
        {
          title: "Meats",
          items: [
            { id: 99123, supc: "4521187", description: "TURKEY BREAST OVEN RSTD", brand: { name: "BRDHEAD" }, pack: "4", size: "5 LB", pricing: { casePrice: { amount: 89.4 }, eachPrice: null } },
            { id: 99124, supc: "3310021", description: "HAM BLACK FOREST", brand: { name: "BRDHEAD" }, pack: "2", size: "10 LB", pricing: { casePrice: { amount: 71.8 } } },
          ],
        },
      ],
      user: { name: "Chris", accountNumber: "12345" },
    },
  };
  const products = extractProducts(response);
  assert.equal(products.length, 2);
  assert.deepEqual(products[0], { sku: "4521187", description: "TURKEY BREAST OVEN RSTD", brand: "BRDHEAD", pack: "4", size: "5 LB", unit: "", casePrice: 89.4, unitPrice: null });
});

test("one pack/size string, unit price, and a price list with each and case", () => {
  const products = extractProducts({
    products: [
      { productNumber: "118822", productDescription: "Chicken Tenders Breaded 4 oz", packSize: "4/5 LB", prices: [{ uom: "CS", price: "$73.90" }], listPrice: 99 },
      { productNumber: "77120", productDescription: "Cup Deli 16 oz", packSize: "1/1000 EA", unitPrice: 0.062, casePrice: 61.99 },
    ],
  });
  assert.equal(products.length, 2);
  assert.equal(products[0].casePrice, 73.9);
  assert.equal(products[1].casePrice, 61.99);
  assert.equal(products[1].unitPrice, 0.062);
});

test("lists that aren't products are ignored", () => {
  assert.deepEqual(extractProducts({ menu: [{ name: "Lists", url: "/lists" }, { name: "Orders", url: "/orders" }], stores: [{ name: "Ogdensburg", id: 1 }] }), []);
});

test("CSV round-trips through the order-guide importer", () => {
  const products = dedupeProducts([
    { sku: "4521187", description: 'TURKEY BREAST, "OVEN" RSTD', brand: "BRDHEAD", pack: "4", size: "5 LB", unit: "", casePrice: 89.4, unitPrice: null },
    { sku: "4521187", description: "TURKEY BREAST OVEN RSTD", brand: "", pack: "4", size: "5 LB", unit: "", casePrice: null, unitPrice: 4.47 },
    { sku: "118822", description: "Chicken Tenders", brand: "", pack: "4/5 LB", size: "", unit: "", casePrice: 73.9, unitPrice: null },
  ]);
  const { products: parsed, fullExport } = parseGuide(productsToCsv(products));
  assert.ok(fullExport);
  assert.deepEqual(parsed.map((p) => [p.sku, p.description, p.packQuantity, p.packUnit, p.priceCents]), [
    ["4521187", 'TURKEY BREAST, "OVEN" RSTD', 20, "lb", 8940],
    ["118822", "Chicken Tenders", 20, "lb", 7390],
  ]);
});

test("finds the sign-in code in supplier emails, not years, prices, or addresses", async () => {
  const { extractSignInCode } = await import("../src/lib/supplier-web-extract.js");
  assert.equal(extractSignInCode("US Foods: Your verification code is 482913. It expires in 10 minutes."), "482913");
  assert.equal(extractSignInCode("<p>Hello,</p><p>Use this one-time code to sign in:</p><h2>&nbsp;730 441&nbsp;</h2>".replace("730 441", "730441")), "730441");
  assert.equal(extractSignInCode("© 2026 US Foods, 9399 W Higgins Rd, Rosemont IL 60018. Order total $1234.50. Your passcode: 5521"), "5521");
  assert.equal(extractSignInCode("Thanks for your order of 2026-10-05. Call 315-555-0100."), null);
});

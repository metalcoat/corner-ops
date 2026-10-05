import test from "node:test";
import assert from "node:assert/strict";
import { dedupeProducts, extractProducts, joinSplitProducts, productsToCsv } from "../src/lib/supplier-web-extract.js";
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

test("US Foods: prices and details from separate responses are joined by product number", () => {
  // Shapes as US Foods' order guide loads them (values made up).
  const details = { items: [
    { productNumber: 1328699, summary: { productDescLong: "Shortening, Frying Soybean Liquid", productDescTxtl: "SHORTENING FRY SOY", brand: "Harvest Value", salesPackSize: "1/35 LB", priceUom: "CS" } },
    { productNumber: 2720977, summary: { productDescLong: "Chicken, Breast Boneless Skinless Raw", brand: "Cross Valley", salesPackSize: "4/10 LB", priceUom: "LB", catchWeightFlag: true } },
    { productNumber: 9999999, summary: { productDescLong: "Not on this account's price list", brand: "X", salesPackSize: "6/1 GAL" } },
  ] };
  const pricing = { messageHeader: { responseCode: 0 }, messageDetail: { productList: [
    { productNumber: "1328699", unitPrice: "41.27", priceUom: "CS", eachPrice: "0" },
    { productNumber: "002720977", unitPrice: "2.89", priceUom: "LB", eachPrice: "0" },
    { productNumber: "5550001", unitPrice: "12.00", priceUom: "CS" },
  ] } };
  const guideItems = [{ productNumber: 1328699, itemSequenceNumber: 1 }, { productNumber: 2720977, itemSequenceNumber: 2 }];
  // Neither response is a product list by itself.
  assert.deepEqual([details, pricing, guideItems].flatMap((r) => extractProducts(r)).filter((p) => p.casePrice != null || p.unitPrice != null), []);
  const products = joinSplitProducts([guideItems, details, pricing]);
  assert.deepEqual(products, [
    { sku: "1328699", description: "Shortening, Frying Soybean Liquid", brand: "Harvest Value", pack: "1/35 LB", size: "", unit: "", casePrice: 41.27, unitPrice: null },
    { sku: "2720977", description: "Chicken, Breast Boneless Skinless Raw", brand: "Cross Valley", pack: "4/10 LB", size: "", unit: "LB", casePrice: null, unitPrice: 2.89 },
  ]);
  // The app's importer reads them: a case price, and a per-pound price times the 40 lb case.
  const { products: parsed } = parseGuide(productsToCsv(products));
  assert.deepEqual(parsed.map((p) => [p.sku, p.packQuantity, p.packUnit, p.priceCents]), [["1328699", 35, "lb", 4127], ["2720977", 40, "lb", 11560]]);
});

test("PFG: an order's guide and its prices are joined by product key", () => {
  // Shapes as PFG's order entry loads them (values made up).
  const guide = { ResultObject: { ProductListCategories: [{ CategoryTitle: "Bakery, Frozen", Products: [
    { ProductListDetailId: "d1", Product: { ProductKey: "k-1", ProductNumber: "G2132", ProductDescription: "Dough Bread Prefried Frozen", ProductBrand: "Bricins", ProductIsCatchWeight: false,
      UnitOfMeasureOrderQuantities: [{ UnitOfMeasure: 0, Quantity: 0, Price: 0, PackSize: "36/7 Oz", UnitOfMeasureAbbreviation: "CS" }] } },
    { ProductListDetailId: "d2", Product: { ProductKey: "k-2", ProductNumber: "5512", ProductDescription: "Beef Brisket Choice", ProductBrand: "IBP", ProductIsCatchWeight: true,
      UnitOfMeasureOrderQuantities: [{ UnitOfMeasure: 0, Quantity: 0, Price: 0, PackSize: "2/12-14 Lb", UnitOfMeasureAbbreviation: "CS" }] } },
    { ProductListDetailId: "d3", Product: { ProductKey: "k-3", ProductNumber: "777", ProductDescription: "Not priced yet", ProductBrand: "X",
      UnitOfMeasureOrderQuantities: [{ UnitOfMeasure: 0, PackSize: "1/5 Lb", UnitOfMeasureAbbreviation: "CS" }] } },
  ] }] } };
  const prices = { ResultObject: { CustomerProductPrices: [
    { ProductKey: "K-1", UnitOfMeasureType: 0, Price: 53.82, ProductAverageWeight: 0 }, // key case differs on the real site
    { ProductKey: "k-2", UnitOfMeasureType: 0, Price: 5.49, ProductAverageWeight: 26 },
  ], UpdatedTotals: false } };
  const products = joinSplitProducts([guide, prices]);
  assert.deepEqual(products, [
    { sku: "G2132", description: "Dough Bread Prefried Frozen", brand: "Bricins", pack: "36/7 Oz", size: "", unit: "", casePrice: 53.82, unitPrice: null },
    { sku: "5512", description: "Beef Brisket Choice", brand: "IBP", pack: "2/12-14 Lb", size: "", unit: "LB", casePrice: null, unitPrice: 5.49 },
  ]);
  const { products: parsed } = parseGuide(productsToCsv(products));
  assert.deepEqual(parsed.map((p) => [p.sku, p.packQuantity, p.packUnit, p.priceCents]), [["G2132", 252, "oz", 5382], ["5512", 26, "lb", 14274]]);
});

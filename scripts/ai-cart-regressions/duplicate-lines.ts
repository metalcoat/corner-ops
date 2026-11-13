// Extra plain pizzas on Chris's dev test calls 2026-11-07 (17:02 d652a714, 17:41 78483e80, 18:33 620d00ee,
// 18:57 1f0c4671): the voice model sent "add" with an existing pizza's lineId (meaning change it), or re-sent a
// pizza already in the cart alongside new items. Each became another pizza.
// Run: npx tsx scripts/ai-cart-regressions/duplicate-lines.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const lines = async (orderId: string | null) => (orderId ? (await h.dbLines(orderId)).map((line: any) => `${line.name}|${line.quantity}|${line.mods.map((m: string) => m.replace(/^.*:/, "").replace(/\[.*$/, "")).filter((m: string) => !/Classic Sauce|Regular Cooked/.test(m)).sort().join(",")}`) : []);
  try {
    await h.check("an add carrying a pizza's lineId changes that pizza (17:02)", async () => {
      const m = await h.newMcpCall();
      const r1 = await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin", quantity: 1 }], customerText: "a jumbo pizza" });
      const lineId = (await h.readCart(r1.orderId!))[0].lineId;
      const r2 = await m.invoke({ operation: "add", items: [{ name: "Pizza", lineId, variant: 'Jumbo Thin 16"', quantity: 1, modifiers: [{ name: "Pepperoni" }] }], customerText: "pepperoni on it" });
      assert.deepEqual(await lines(r2.orderId), ["Pizza|1|Pepperoni"]);
    });
    await h.check("a pizza re-sent with new items isn't added again (17:41)", async () => {
      const m = await h.newMcpCall();
      await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin", quantity: 1, modifiers: [{ name: "Pepperoni" }] }], customerText: "large pepperoni pizza" });
      const r = await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin 16 inch/12 slices", quantity: 1 }, { name: "Small French Fries", quantity: 1 }], customerText: "some fries" });
      const got = await lines(r.orderId);
      assert.equal(got.filter((line) => line.startsWith("Pizza|")).length, 1, JSON.stringify(got));
      assert.ok(got.some((line) => /French Fries/.test(line)), JSON.stringify(got));
    });
    await h.check("two pizzas split by lineId: the 2x line becomes the first pizza, the other is added (18:33)", async () => {
      const m = await h.newMcpCall();
      const r1 = await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin", quantity: 2 }], customerText: "two jumbo pizzas" });
      const lineId = (await h.readCart(r1.orderId!))[0].lineId;
      const r2 = await m.invoke({ operation: "add", items: [{ name: "Pizza", lineId, variant: 'Jumbo Thin 16"', quantity: 1, modifiers: [{ name: "Pepperoni" }] }, { name: "Pizza", variant: 'Jumbo Thin 16"', quantity: 1, modifiers: [{ name: "Pepperoni" }, { name: "Sausage" }] }], customerText: "pepperoni on one and pepperoni sausage on the other" });
      assert.deepEqual((await lines(r2.orderId)).sort(), ["Pizza|1|Pepperoni", "Pizza|1|Pepperoni,Sausage"]);
    });
    await h.check("asking for another of the same pizza still adds it", async () => {
      const m = await h.newMcpCall();
      await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin", quantity: 1, modifiers: [{ name: "Pepperoni" }] }], customerText: "jumbo pepperoni" });
      const r = await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin", quantity: 1, modifiers: [{ name: "Pepperoni" }] }, { name: "2L Pepsi", quantity: 1 }], customerText: "and another pepperoni pizza and a 2 liter Pepsi" });
      assert.equal((await lines(r.orderId)).filter((line) => line.startsWith("Pizza|")).length, 2);
    });
  } finally {
    await h.cleanup();
  }
  h.summary();
  process.exit(process.exitCode || 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Regression from Chris's dev test call 2026-11-06 (f98e637f): "half sausage, other half bacon, and peppers,
// whole thing extra sauce" was refused as "Modifier is invalid or ambiguous." because the voice model sent
// "Bacon Pizza Topping", "Hot Hot Peppers", "Sweet Sweet Peppers" and extra as an amount on Classic Sauce.
// Run: npx tsx scripts/ai-cart-regressions/pizza-names.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const pizza = { name: "Pizza", variant: "Jumbo Thin", quantity: 1 };
  try {
    await h.check("the exact model request from the call prices: doubled words, group suffix, sweet peppers, extra sauce", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [pizza] });
      const c = await h.readCart(r0.orderId!);
      const r = await m.invoke({
        operation: "replace_item",
        targetLineId: c[0].lineId,
        items: [{ ...pizza, lineId: c[0].lineId, modifiers: [
          { name: "Sausage", amount: "regular", portion: "left_half", placement: "topping" },
          { name: "Bacon Pizza Topping", amount: "regular", portion: "right_half", placement: "topping" },
          { name: "Hot Hot Peppers", amount: "regular", portion: "right_half", placement: "topping" },
          { name: "Sweet Sweet Peppers", amount: "regular", portion: "right_half", placement: "topping" },
          { name: "Classic Sauce", amount: "extra", portion: "whole", placement: "topping" },
        ] }],
      });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const mods = (await h.dbLines(r0.orderId!))[0].mods.map((m: string) => m.replace(/\[.*$/, ""));
      for (const want of ["Pizza Toppings:Sausage", "Pizza Toppings:Bacon", "Pizza Toppings:Hot Peppers", "Pizza Toppings:Peppers", "Pizza Toppings:Extra Sauce", "Pizza Sauce:Classic Sauce"])
        assert.ok(mods.includes(want), `${want} missing from ${JSON.stringify(mods)}`);
    });
    await h.check("an unknown topping names itself in the error and changes nothing", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [{ ...pizza, modifiers: [{ name: "Sausage", placement: "topping" }] }] });
      const c = await h.readCart(r0.orderId!);
      const before = await h.snapshot(r0.orderId!);
      const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ ...pizza, lineId: c[0].lineId, modifiers: [{ name: "Purple Peppers", placement: "topping" }] }] });
      assert.ok(r.isError, JSON.stringify(r.body));
      assert.match(String(r.body.error?.message), /Purple Peppers isn't an option/);
      assert.equal(await h.snapshot(r0.orderId!), before);
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

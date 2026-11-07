// Regression from Chris's dev test call 2026-11-07 15:10 (036f046f): the voice model sent modifiers with group
// names the item doesn't have ("Toppings" on a pizza, "Blue Cheese/Ranch/Celery" on wings). Pepperoni, blue cheese
// and celery all came back "isn't an option", the wings never got on the order, and the caller hung up.
// Run: npx tsx scripts/ai-cart-regressions/model-groups.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const mods = async (orderId: string, index = 0) => (await h.dbLines(orderId))[index].mods.map((m: string) => m.replace(/\[.*$/, ""));
  try {
    await h.check("pizza edit: Pepperoni sent in group 'Toppings' lands on the pizza", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: 'Jumbo Thin 16"', quantity: 1 }] });
      const c = await h.readCart(r0.orderId!);
      const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Pizza", lineId: c[0].lineId, variant: 'Jumbo Thin 16"', quantity: 1, modifiers: [{ name: "Pepperoni", group: "Toppings", amount: "regular", portion: "whole", placement: "topping" }] }] });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      assert.ok((await mods(r0.orderId!)).includes("Pizza Toppings:Pepperoni"), JSON.stringify(await mods(r0.orderId!)));
    });
    await h.check("wings add: Blue Cheese and Celery sent in group 'Blue Cheese/Ranch/Celery' are added", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ name: "Wings", variant: "30 Wings", quantity: 1, modifiers: [
        { name: "Mild", group: "Wing Sauce", amount: "regular", portion: "whole", placement: "topping" },
        { name: "Blue Cheese", group: "Blue Cheese/Ranch/Celery", amount: "regular", portion: "whole", placement: "side" },
        { name: "Celery", group: "Blue Cheese/Ranch/Celery", amount: "regular", portion: "whole", placement: "side" },
      ] }] });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const names = await mods(r.orderId!);
      for (const want of ["Wing Sauce:Mild", "Wings Add Ons:Blue Cheese (4oz)", "Wings Add Ons:Celery"]) assert.ok(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
    });
    await h.check("wings edit: Blue Cheese / Celery in the made-up group are added to the existing line", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [{ name: "Wings", variant: "20 Wings", quantity: 1, modifiers: [{ name: "Medium" }] }] });
      const c = await h.readCart(r0.orderId!);
      const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Wings", lineId: c[0].lineId, variant: "20 Wings", quantity: 1, modifiers: [
        { name: "Medium", group: "Wing Sauce", amount: "regular" },
        { name: "Blue Cheese", group: "Blue Cheese/Ranch/Celery", amount: "regular" },
        { name: "Celery", group: "Blue Cheese/Ranch/Celery", amount: "regular" },
      ] }] });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const names = await mods(r0.orderId!);
      for (const want of ["Wing Sauce:Medium", "Wings Add Ons:Blue Cheese (4oz)", "Wings Add Ons:Celery"]) assert.ok(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
    });
    await h.check("an option the item doesn't have still fails, wrong group or not", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: 'Jumbo Thin 16"', quantity: 1 }] });
      const c = await h.readCart(r0.orderId!);
      const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Pizza", lineId: c[0].lineId, variant: 'Jumbo Thin 16"', quantity: 1, modifiers: [{ name: "Purple Peppers", group: "Toppings" }] }] });
      assert.ok(r.isError, JSON.stringify(r.body));
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

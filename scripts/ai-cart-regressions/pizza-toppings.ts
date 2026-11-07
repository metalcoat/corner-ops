// Regressions from Chris's dev test call 2026-11-07 18:34 (620d00ee): "two jumbo pizzas" went in plain with no
// toppings question, and "cheesy bread" found Cheesy Breadsticks but the caller only heard "we don't have that".
// Run: npx tsx scripts/ai-cart-regressions/pizza-toppings.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const pizza = (quantity = 1) => [{ name: "Pizza", variant: "Jumbo Thin", quantity }];
  try {
    await h.check("two plain jumbo pizzas: asks what goes on them", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: pizza(2), customerText: "Um, can I get two jumbo pizzas?" });
      assert.ok(!r.isError, JSON.stringify(r.body));
      assert.equal(r.body.required_follow_up, "What would you like on them? If they're different, tell me each one.");
    });
    await h.check("one plain pizza: asks toppings or just cheese", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: pizza(), customerText: "a large pizza" });
      assert.equal(r.body.required_follow_up, "What would you like on it, or just cheese?");
    });
    await h.check("a cheese pizza is not asked about", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: pizza(), customerText: "a large cheese pizza" });
      assert.ok(!r.body.required_follow_up, JSON.stringify(r.body.required_follow_up));
    });
    await h.check("a topping the caller named is not asked again (the checker adds a missed one)", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: pizza(), customerText: "can we get a large pepperoni pizza" });
      assert.ok(!r.body.required_follow_up, JSON.stringify(r.body.required_follow_up));
    });
    await h.check("a pizza sent with toppings is not asked about", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ ...pizza()[0], modifiers: [{ name: "Sausage" }] }], customerText: "jumbo sausage" });
      assert.ok(!r.body.required_follow_up, JSON.stringify(r.body.required_follow_up));
    });
    await h.check("a close menu match is offered, not refused", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ name: "Cheesy Bread", quantity: 1 }], customerText: "cheesy bread" });
      assert.ok(r.isError, JSON.stringify(r.body));
      assert.equal(r.body.error?.message, "We have Cheesy Breadsticks, would you like those?", JSON.stringify(r.body));
      assert.ok(!r.orderId || !(await h.dbLines(r.orderId)).some((line: any) => /breadstick/i.test(line.name)));
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

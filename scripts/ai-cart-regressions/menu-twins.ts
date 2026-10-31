// Regression (failed before the 2026-10-25 fix), found by the full menu sweep (npm run test:ai-menu-sweep):
// same-named menu items, deli salads by the pound, size words in the name, and the Pizza Sub.
// Run: npx tsx scripts/ai-cart-regressions/menu-twins.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

const decisions = { coldSubCondimentsDecision: "declined", coldSubVegetablesDecision: "declined", burgerToppingsDecision: "declined", burgerFriesDecision: "declined" };

async function main() {
  const h = await loadHarness();
  try {
    const cases: Array<[string, any, RegExp]> = [
      ["Pizza Sub, full sub, is the sub (not a pizza)", { name: "Pizza Sub", variant: "Full Sub" }, /^Pizza Sub$/],
      ["Popcorn Chicken full sub is the sub, not the appetizer", { name: "Popcorn Chicken", variant: "Full Sub" }, /^Popcorn Chicken$/],
      ["plain 'Hamburger' is the burger", { name: "Hamburger" }, /^Hamburger$/],
      ["'a pound of potato salad' is the 1 lb deli salad", { name: "a pound of potato salad" }, /^Potato Salad$/],
      ["'small potato salad' is the small counter size", { name: "small potato salad" }, /^Potato Salad$/],
      ["Mac Salad by the pound", { name: "Mac Salad", variant: "Feeds 3 · 1.00 lb" }, /^Mac Salad$/],
    ];
    // Dev replay 2026-10-25: "turkey and ham" on a build-your-own sub was "ambiguous" 25 times in a row
    // (each meat is in both the free and the paid meat group).
    await h.check("build-your-own sub with two meats fills the free and the paid meat", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ name: "Custom", variant: "Full Sub", modifiers: [{ name: "Turkey (Full Portion)" }, { name: "Ham (Full Portion)" }, { name: "American" }, { name: "Mayonnaise" }] }], ...decisions, coldSubCondimentsDecision: "selected" });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const mods = (await h.dbLines(r.orderId!))[0].mods.join(" ");
      assert.match(mods, /Custom Sub \(1 Free\):/);
      assert.match(mods, /Custom Sub:/);
    });
    for (const [label, item, name] of cases) {
      await h.check(label, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [item], ...decisions });
        assert.ok(!r.isError, JSON.stringify(r.body));
        if (!r.body.pending) {
          const lines = await h.dbLines(r.orderId!);
          assert.match(lines[0].name, name);
          if (/pound/.test(item.name)) assert.match(lines[0].variant, /1\.00 lb/);
          if (/small/.test(item.name)) assert.match(lines[0].variant, /^Small/);
          if (item.name === "Hamburger") assert.equal(lines[0].variant, "");
        } else assert.doesNotMatch(String(r.body.requiredFollowUp), /requires a size|which one/i);
      });
    }
  } finally {
    await h.cleanup();
  }
  h.summary();
}
main();

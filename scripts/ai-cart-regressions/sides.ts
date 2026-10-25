// Regression (failed before the 2026-10-25 fix), from a dev test call: a Chicken Tender Dinner's sauce
// was refused because the model named the group "Dipping Sauce" (the item's is "Dipping Sauces dinner (4oz)")
// or said "bbq sauce", so the dinner was dropped; "ranch sauce" / "side of ranch" weren't found as the
// 4oz cup item. Run: npx tsx scripts/ai-cart-regressions/sides.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  try {
    for (const sauce of [{ name: "BBQ", group: "Dipping Sauce" }, { name: "bbq sauce" }, { name: "Sweet & Sour", group: "Dipping Sauce" }]) {
      await h.check(`Chicken Tender Dinner sauce ${JSON.stringify(sauce)} is accepted`, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [{ name: "Chicken Tender Dinner", modifiers: [sauce, { name: "Side Coleslaw (4oz)", group: "Coleslaw Dinner" }, { name: "Small Fry" }] }] });
        assert.ok(!r.isError, JSON.stringify(r.body));
        if (!r.body.pending) {
          const lines = await h.dbLines(r.orderId!);
          assert.ok(lines[0].mods.some((mod: string) => /(BBQ|Sweet & Sour)/.test(mod)), JSON.stringify(lines[0].mods));
        } else assert.doesNotMatch(String(r.body.requiredFollowUp), /sauce/i);
      });
    }
    for (const item of [{ name: "Ranch Sauce", variant: "4oz Cup" }, { name: "side of ranch" }]) {
      await h.check(`${JSON.stringify(item)} adds a ranch cup`, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [item] });
        assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
        assert.match((await h.dbLines(r.orderId!))[0].name, /ranch/i);
      });
    }
  } finally {
    await h.cleanup();
  }
  h.summary();
}
main();

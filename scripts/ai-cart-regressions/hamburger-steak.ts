// Regression from Chris's dev test call 2026-11-07 17:03 (d652a714): the voice model re-sent a bare "Hamburger
// Steak" with the caller's answer only as customerText, so "What kind of dressing..." was asked six times while the
// caller said "Italian". Also Chris's order for this meal: toppings first, then "It comes with a small salad. What
// dressing would you like?".
// Run: npx tsx scripts/ai-cart-regressions/hamburger-steak.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const mods = async (orderId: string) => (await h.dbLines(orderId)).flatMap((line: any) => line.mods.map((m: string) => m.replace(/\[.*$/, "")));
  const steak = [{ name: "Hamburger Steak", quantity: 1 }];
  try {
    await h.check("toppings are asked first, then the dressing, with bare re-sends", async () => {
      const m = await h.newMcpCall();
      const r1 = await m.invoke({ operation: "add", items: steak, customerText: "Can I get a hamburger steak?" });
      assert.equal(r1.body.requiredFollowUp, "Would you like peppers, mushrooms, or onions on that?", JSON.stringify(r1.body));
      const r2 = await m.invoke({ operation: "add", items: steak, customerText: "Mushrooms and onions." });
      assert.equal(r2.body.requiredFollowUp, "It comes with a small salad. What dressing would you like?", JSON.stringify(r2.body));
      const r3 = await m.invoke({ operation: "add", items: steak, customerText: "Italian" });
      assert.ok(!r3.isError && !r3.body.pending, JSON.stringify(r3.body));
      const names = await mods(r3.orderId!);
      for (const want of ["Hamburger Steak Options:Mushrooms", "Hamburger Steak Options:Onions", "Choose Dressing (On Salad):Italian (On Salad)"])
        assert.ok(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
      assert.ok(!names.includes("Hamburger Steak Options:Peppers"), JSON.stringify(names));
    });
    await h.check("a mumbled dressing answer still finds the one dressing named", async () => {
      const m = await h.newMcpCall();
      await m.invoke({ operation: "add", items: steak, customerText: "hamburger steak" });
      await m.invoke({ operation: "add", items: steak, customerText: "No." });
      const r = await m.invoke({ operation: "add", items: steak, customerText: "Italian crumble low" });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const names = await mods(r.orderId!);
      assert.ok(names.includes("Choose Dressing (On Salad):Italian (On Salad)"), JSON.stringify(names));
      assert.ok(!names.some((name: string) => name.startsWith("Hamburger Steak Options:")), JSON.stringify(names));
    });
    await h.check("a bare yes to the toppings means all three", async () => {
      const m = await h.newMcpCall();
      await m.invoke({ operation: "add", items: steak, customerText: "hamburger steak" });
      const r = await m.invoke({ operation: "add", items: steak, customerText: "Yeah." });
      assert.ok(r.body.requiredFollowUp?.includes("dressing"), JSON.stringify(r.body));
      const done = await m.invoke({ operation: "add", items: steak, customerText: "Ranch" });
      const names = await mods(done.orderId!);
      for (const want of ["Mushrooms", "Onions", "Peppers"]) assert.ok(names.includes(`Hamburger Steak Options:${want}`), JSON.stringify(names));
    });
    await h.check("toppings named with the order skip the toppings question", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ name: "Hamburger Steak", quantity: 1, modifiers: [{ name: "Peppers" }] }], customerText: "hamburger steak with peppers" });
      assert.ok(r.body.requiredFollowUp?.includes("dressing"), JSON.stringify(r.body));
    });
    await h.check("an unclear dressing answer asks again instead of guessing", async () => {
      const m = await h.newMcpCall();
      await m.invoke({ operation: "add", items: [{ name: "Hamburger Steak", quantity: 1, modifiers: [{ name: "Onions" }] }], customerText: "hamburger steak with onions" });
      const r = await m.invoke({ operation: "add", items: steak, customerText: "um what do you have" });
      assert.ok(r.body.pending && r.body.requiredFollowUp?.includes("dressing"), JSON.stringify(r.body));
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

// Regressions from Chris's dev test call 2026-11-06 (b08100aa): "gravy on the fries" on a Hot Turkey meal was
// refused three times (Gravy on Fries was switched off 2026-10-28; migration 0037 turns it back on). Gravy on a
// hot meat meal's side is asked about, charged, and goes on top; wings are read back the short way staff say them.
// Run: npx tsx scripts/ai-cart-regressions/hot-meal-gravy.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const mods = async (orderId: string) => (await h.dbLines(orderId))[0].mods.map((m: string) => m.replace(/\[.*$/, ""));
  const hotTurkey = (side: Record<string, unknown>[]) => [
    { name: "Hot Turkey", quantity: 1, modifiers: [{ name: "Italian" }, ...side] },
  ];
  try {
    await h.check("Hot Turkey with fries and 'gravy on the fries' puts Gravy on Fries on the meal", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: hotTurkey([{ name: "Small French Fries" }, { name: "gravy on the fries" }]) });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      assert.ok((await mods(r.orderId!)).includes("Fry Option:Gravy on Fries"), JSON.stringify(await mods(r.orderId!)));
    });
    await h.check("a meal is one container: plain 'gravy' with the meal's fries goes on the fries", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: hotTurkey([{ name: "Small French Fries" }, { name: "gravy" }]) });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      assert.ok((await mods(r.orderId!)).includes("Fry Option:Gravy on Fries"), JSON.stringify(await mods(r.orderId!)));
    });
    await h.check("'gravy on the side' with the meal's fries stays on the side", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: hotTurkey([{ name: "Small French Fries" }, { name: "gravy on the side" }]) });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      assert.ok((await mods(r.orderId!)).includes("Fry Option:Gravy on Side"), JSON.stringify(await mods(r.orderId!)));
    });
    // Gravy is never free and is asked, not assumed (Chris 2026-11-06): mashed without gravy gets the question.
    for (const meal of ["Hot Turkey", "Hot Roast Beef", "Hot Hamburger"])
      await h.check(`${meal} with mashed asks about gravy and adds none until the caller says yes`, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [{ name: meal, quantity: 1, modifiers: [{ name: "Italian" }, { name: "small mashed" }] }] });
        assert.match(String(r.body.requiredFollowUp || r.body.required_follow_up || ""), /Gravy on the mashed potatoes\?/, JSON.stringify(r.body));
        if (r.orderId) assert.ok(!(await mods(r.orderId)).includes("Mashed Mods:Gravy"));
      });
    await h.check("Hot Turkey with mashed and gravy puts charged Gravy on the mashed", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ name: "Hot Turkey", quantity: 1, modifiers: [{ name: "Italian" }, { name: "small mashed" }, { name: "gravy" }] }] });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const lines = await h.dbLines(r.orderId!);
      assert.ok(lines[0].mods.some((n: string) => /^Mashed Mods:Gravy\[/.test(n)), JSON.stringify(lines[0].mods));
    });

    await h.check("wings read back short: count, flavor, then shared dips once", async () => {
      const { wingReadback } = h.cart;
      const sides = [
        { group: "Wings Add Ons", name: "Blue Cheese (4oz)" },
        { group: "Wings Add Ons", name: "Celery" },
      ];
      assert.equal(
        wingReadback([
          { name: "Wings", variant: "10 Wings", quantity: 1, modifiers: [{ group: "Wing Sauce", name: "Mild" }, ...sides] },
          { name: "Wings", variant: "10 Wings", quantity: 1, modifiers: [{ group: "Wing Sauce", name: "Garlic Parmesan" }, ...sides] },
        ]),
        "10 wings mild, 10 wings garlic parm, and blue cheese and celery with those",
      );
      assert.equal(
        wingReadback([{ name: "Wings", variant: "20 Wings", quantity: 1, modifiers: [{ group: "Wing Sauce", name: "Medium" }, { group: "Wings Add Ons", name: "Ranch (4oz)" }] }]),
        "20 wings medium and ranch with that",
      );
      assert.equal(
        wingReadback([
          { name: "Wings", variant: "10 Wings", quantity: 1, modifiers: [{ group: "Wing Sauce", name: "Hot" }, { group: "Wings Add Ons", name: "Extra Crispy" }, { group: "Wings Add Ons", name: "Ranch (4oz)" }] },
          { name: "Boneless Wings", variant: "12 Boneless", quantity: 1, modifiers: [{ group: "Wing Sauce", name: "BBQ" }] },
        ]),
        "10 wings hot and extra crispy with ranch and 12 boneless wings bbq",
      );
    });

    await h.check("live cart result carries wingReadback and short wing lines (no ounces, no bone-in)", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({
        operation: "add",
        items: [
          { name: "Wings", variant: "10 Wings", quantity: 1, modifiers: [{ name: "Mild" }, { name: "Blue Cheese (4oz)" }, { name: "Celery" }] },
          { name: "Wings", variant: "10 Wings", quantity: 1, modifiers: [{ name: "Garlic Parmesan" }, { name: "Blue Cheese (4oz)" }, { name: "Celery" }] },
        ],
        wingAddOnDecision: "selected",
      });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      assert.equal(r.body.wingReadback, "10 wings mild, 10 wings garlic parm, and blue cheese and celery with those");
      for (const line of r.body.lines) assert.doesNotMatch(String(line.say), /oz|bone|\$/i);
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

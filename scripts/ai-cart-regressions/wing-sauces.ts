// Regression: every Wing Sauce catalog option as a flavor-only change, preserving dressing, celery
// and every extra 4oz side sauce. Run: npx tsx scripts/ai-cart-regressions/wing-sauces.ts (regressions; failed before the 2026-10-25 fix)
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  try {
    const flavors = await h.wingSauceOptions();
    const cups = (
      await h.sql`SELECT o.name FROM ordering_modifier_options o JOIN ordering_modifier_groups g ON g.id=o.group_id WHERE g.business='Corner Deli' AND g.name='Wings Add Ons' AND o.active AND o.available AND o.name ~* '\\(4oz\\)' AND o.name !~* '^(blue cheese|ranch)' ORDER BY o.sort_order,o.name`
    ).map((r: any) => String(r.name));
    console.log("Wing Sauce:", flavors.join(" | "), "\nExtra cups:", cups.join(" | "));
    assert.ok(flavors.length >= 10 && cups.length >= 8);
    for (const cup of cups)
      await h.check(`flavor-only change keeps Blue Cheese, Celery and extra cup "${cup}" for all ${flavors.length} flavors; other line untouched`, async () => {
        const failures: string[] = [];
        for (const flavor of flavors) {
          const from = flavor === "Plain" ? "Hot" : "Plain";
          const m = await h.newMcpCall();
          const r0 = await m.invoke({
            operation: "add",
            items: [
              { name: "Wings", variant: "12 Wings", quantity: 1, modifiers: [{ name: from }, { name: "Blue Cheese (4oz)" }, { name: "Celery" }, { name: cup }] },
              { name: "Wings", variant: "10 Wings", quantity: 1, modifiers: [{ name: "Suicide" }] },
            ],
          });
          assert.ok(!r0.isError && !r0.body.pending, JSON.stringify(r0.body));
          const c = await h.readCart(r0.orderId!);
          const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Wings", quantity: 1, modifiers: [{ name: flavor }] }] });
          const after = await h.dbLines(r0.orderId!);
          const names = after[0].mods.map((x: string) => x.split(":")[1].replace(/\[.*$/, ""));
          const missing = [flavor, "Blue Cheese (4oz)", "Celery", cup].filter((w) => !names.includes(w));
          if (r.isError || missing.length || names.includes(from) || after[1].mods.join() !== "Wing Sauce:Suicide[selected]")
            failures.push(`${from}->${flavor}: ${r.isError ? r.body.error?.code : "missing " + JSON.stringify(missing)}`);
        }
        assert.deepEqual(failures, []);
      });

    await h.check("DEFECT flavor change spoken as '<flavor> sauce' must change the flavor (not just add a paid 4oz cup)", async () => {
      const failures: string[] = [];
      for (const [spoken, flavor] of [["BBQ sauce", "BBQ"], ["hot sauce", "Hot"], ["mild sauce", "Mild"], ["suicide sauce", "Suicide"]]) {
        const m = await h.newMcpCall();
        const r0 = await m.invoke({ operation: "add", items: [{ name: "Wings", variant: "12 Wings", quantity: 1, modifiers: [{ name: "Plain" }] }] });
        const c = await h.readCart(r0.orderId!);
        const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Wings", quantity: 1, modifiers: [{ name: spoken }] }] });
        const mods = (await h.dbLines(r0.orderId!))[0].mods;
        if (!r.isError && !r.body.pending && !mods.includes(`Wing Sauce:${flavor}[selected]`)) failures.push(`${spoken}: ${JSON.stringify(mods)}`);
      }
      assert.deepEqual(failures, []);
    });
  } finally {
    await h.cleanup();
  }
  h.summary();
  process.exit(process.exitCode || 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

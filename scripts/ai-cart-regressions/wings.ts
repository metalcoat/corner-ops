// Regression: wing count/flavor corrections through MCP price_order and the sideband pipeline.
// Run: npx tsx scripts/ai-cart-regressions/wings.ts (regressions; failed before the 2026-10-25 fix)
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const W = (variant: string, flavor: string, extra: any[] = []) => ({ name: "Wings", variant, quantity: 1, modifiers: [{ name: flavor }, ...extra] });
  const base = () => [W("30 Wings", "Medium", [{ name: "Blue Cheese" }]), W("20 Wings", "Hot"), { name: "Caramel Cheesecake", quantity: 1 }];
  const wingCount = (lines: any[]) =>
    lines.filter((l) => l.name === "Wings").reduce((n, l) => n + Number(String(l.variant).match(/\d+/)?.[0] || 0) * l.quantity, 0);
  try {
    await h.check("MCP: 30 Medium(+BC) + 20 Hot -> '30 total: 20 Medium, 10 Hot' batch without IDs is atomic", async () => {
      const m = await h.newMcpCall();
      let r = await m.invoke({ operation: "add", items: base() });
      const id = r.orderId!;
      const before = await h.dbLines(id);
      r = await m.invoke({ operation: "replace_item", items: [W("20 Wings", "Medium"), W("10 Wings", "Hot")] });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const after = await h.dbLines(id);
      assert.deepEqual(after.map((l) => l.lineId), before.map((l) => l.lineId));
      assert.equal(after[0].variant, "20 Wings");
      assert.ok(after[0].mods.includes("Wing Sauce:Medium[selected]") && after[0].mods.includes("Wings Add Ons:Blue Cheese (4oz)[selected]"));
      assert.equal(after[1].variant, "10 Wings");
      assert.deepEqual(after[1].mods, ["Wing Sauce:Hot[selected]"]);
      assert.deepEqual(after[2], before[2]);
      assert.equal(wingCount(after), 30);
    });

    await h.check("sideband: same correction, readback lists 20 + 10 = 30 wings with dressing kept", async () => {
      const s = h.newSidebandCall();
      let x = await s.invoke({ operation: "add", serviceType: "pickup", items: base() }, "thirty medium with blue cheese and twenty hot");
      assert.ok(x.ok, x.error?.message);
      x = await s.invoke({ operation: "replace_item", serviceType: "pickup", items: [W("20 Wings", "Medium"), W("10 Wings", "Hot")] }, "thirty wings total, twenty medium and ten hot");
      assert.ok(x.ok, x.error?.message);
      assert.equal(wingCount(x.compact.lines), 30);
      assert.ok(x.compact.lines[0].modifiers.some((mm: any) => mm.name === "Blue Cheese (4oz)"));
      assert.equal(x.compact.lines[2].name, "Sea Salt Caramel Cheesecake");
    });

    await h.check("explicit per-line IDs; identical lines; ambiguous/stale/duplicate/invalid batches leave cart byte-identical", async () => {
      const m = await h.newMcpCall();
      let r = await m.invoke({ operation: "add", items: [W("12 Wings", "Mild"), W("12 Wings", "Mild"), { name: "Caramel Cheesecake", quantity: 1 }] });
      const id = r.orderId!;
      const c = await h.readCart(id);
      assert.notEqual(c[0].lineId, c[1].lineId);
      const before = await h.snapshot(id);
      const attempts: Array<[string, any, string]> = [
        ["ambiguous identical lines, no IDs", { operation: "replace_item", items: [W("12 Wings", "Mild"), W("12 Wings", "Mild")] }, "FOLLOW_UP_REQUIRED"],
        ["stale ID", { operation: "replace_item", items: [{ ...W("12 Wings", "Hot"), lineId: c[0].lineId }, { ...W("10 Wings", "Hot"), lineId: "stale" }] }, "FOLLOW_UP_REQUIRED"],
        ["duplicate ID", { operation: "replace_item", items: [{ ...W("12 Wings", "Hot"), lineId: c[0].lineId }, { ...W("10 Wings", "Hot"), lineId: c[0].lineId }] }, "INVALID_INPUT"],
        ["2nd modifier invalid", { operation: "replace_item", items: [{ ...W("12 Wings", "Hot"), lineId: c[0].lineId }, { ...W("10 Wings", "Hot", [{ name: "avocado" }]), lineId: c[1].lineId }] }, "INVALID_MODIFIER"],
        ["2nd modifier wrong group", { operation: "replace_item", items: [{ ...W("12 Wings", "Hot"), lineId: c[0].lineId }, { name: "Wings", quantity: 1, lineId: c[1].lineId, modifiers: [{ name: "Hot", group: "Dressing" }] }] }, "INVALID_MODIFIER"],
        ["2nd flavor not on menu", { operation: "replace_item", items: [{ ...W("12 Wings", "Hot"), lineId: c[0].lineId }, { ...W("10 Wings", "Lemon Pepper"), lineId: c[1].lineId }] }, "INVALID_MODIFIER"],
        ["2nd ID is the cheesecake", { operation: "replace_item", items: [{ ...W("12 Wings", "Hot"), lineId: c[0].lineId }, { ...W("10 Wings", "Hot"), lineId: c[2].lineId }] }, "INVALID_MODIFIER"],
        ["single stale target", { operation: "replace_item", targetLineId: "stale", items: [W("12 Wings", "Hot")] }, "INVALID_INPUT"],
        ["single target by name", { operation: "replace_item", targetLineId: "Wings", items: [W("12 Wings", "Hot")] }, "INVALID_INPUT"],
      ];
      for (const [label, args, code] of attempts) {
        const x = await m.invoke(args);
        assert.equal(x.body.error?.code || x.body.code, code, label + " " + JSON.stringify(x.body));
        assert.equal(await h.snapshot(id), before, label);
      }
      r = await m.invoke({ operation: "replace_item", items: [{ ...W("12 Wings", "Medium"), lineId: c[0].lineId }, { ...W("12 Wings", "Suicide"), lineId: c[1].lineId }] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      const after = await h.dbLines(id);
      assert.deepEqual(after[0].mods, ["Wing Sauce:Medium[selected]"]);
      assert.deepEqual(after[1].mods, ["Wing Sauce:Suicide[selected]"]);
    });

    // ---------------- defects ----------------
    await h.check("DEFECT CRITICAL replace with wing count in quantity ('make it 20') must not become 20 x 30 Wings", async () => {
      // On add, {name:"Wings", quantity:20} means 20 wings. On replace, mergeSpokenCartLine keeps the old
      // variant "30 Wings" (openai-phone-sideband.ts:475) so priceSpokenOrder treats 20 as line quantity.
      const m = await h.newMcpCall();
      let r = await m.invoke({ operation: "add", items: base() });
      const id = r.orderId!;
      const c = await h.readCart(id);
      r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Wings", quantity: 20, modifiers: [{ name: "Medium" }] }] });
      const line = (await h.dbLines(id))[0];
      assert.ok(r.isError || r.body.pending || (line.quantity === 1 && line.variant === "20 Wings"), `got ${line.quantity} x ${line.variant} = $${line.lineTotal / 100}`);
    });

    await h.check("DEFECT remove_item with two lineIds must remove both or refuse (not silently remove only the first)", async () => {
      const m = await h.newMcpCall();
      let r = await m.invoke({ operation: "add", items: base() });
      const id = r.orderId!;
      const c = await h.readCart(id);
      const before = await h.snapshot(id);
      r = await m.invoke({ operation: "remove_item", items: [{ name: "Wings", quantity: 1, lineId: c[0].lineId }, { name: "Wings", quantity: 1, lineId: c[1].lineId }] });
      const names = (await h.dbLines(id)).map((l) => l.name);
      assert.ok((r.isError && (await h.snapshot(id)) === before) || !names.includes("Wings"), `success=${!r.isError}; remaining ${JSON.stringify(names)}`);
    });

    await h.check("DEFECT MCP price_order result must expose each line's modifiers (flavor) so the model can pick lineIds", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [W("12 Wings", "Mild"), W("12 Wings", "Hot")] });
      const lines = r.body.lines || [];
      assert.equal(lines.length, 2);
      assert.ok(lines.every((l: any) => Array.isArray(l.modifiers)), `line keys: ${Object.keys(lines[0] || {}).join(",")}`);
    });

    await h.check("DEFECT sideband must not re-ask 'blue cheese, ranch, or celery?' after a flavor-only change on a line that has them", async () => {
      const s = h.newSidebandCall();
      let x = await s.invoke({ operation: "add", serviceType: "pickup", items: [W("12 Wings", "Mild", [{ name: "Blue Cheese" }, { name: "Celery" }])] }, "");
      assert.ok(x.ok, x.error?.message);
      assert.equal(x.compact.requiredFollowUp, undefined);
      x = await s.invoke({ operation: "replace_item", serviceType: "pickup", targetLineId: x.compact.lines[0].lineId, items: [{ name: "Wings", quantity: 1, modifiers: [{ name: "Hot" }] }] }, "make those hot");
      assert.ok(x.ok, x.error?.message);
      assert.equal(x.compact.requiredFollowUp, undefined, `requiredFollowUp=${x.compact.requiredFollowUp}; modifiers=${JSON.stringify(x.compact.lines[0].modifiers.map((mm: any) => mm.name))}`);
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

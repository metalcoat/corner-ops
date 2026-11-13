// Regression: Turkey Big Boss recipe omissions through the real MCP price_order route and the
// sideband executePriceOrder pipeline. Run: npx tsx scripts/ai-cart-regressions/bigboss.ts (regressions; failed before the 2026-10-25 fix)
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const TBB = (modifiers: any[] = []) => ({ name: "Turkey Big Boss", quantity: 1, modifiers });
  const modNames = async (orderId: string, index = 0) =>
    (await h.dbLines(orderId))[index].mods.map((m: string) => m.replace(/\[.*$/, ""));
  try {
    for (const mod of [{ name: "no tomato" }, { name: "without tomatoes" }, { name: "Tomatoes", remove: true }]) {
      await h.check(`MCP initial omission ${JSON.stringify(mod)} -> No Tomato`, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [TBB([mod])] });
        assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
        assert.deepEqual(await modNames(r.orderId!), ["Big Boss mods:No Tomato"]);
        assert.equal(Number(r.body.total_cents), 1225);
      });
      await h.check(`sideband initial omission ${JSON.stringify(mod)} -> No Tomato`, async () => {
        const s = h.newSidebandCall();
        const x = await s.invoke({ operation: "add", serviceType: "pickup", items: [TBB([mod])] });
        assert.ok(x.ok, x.error?.message);
        assert.deepEqual(x.compact.lines[0].modifiers.map((m: any) => m.name), ["No Tomato"]);
      });
    }

    await h.check("MCP edit sequence: +No Russian keeps No Tomato; restore via {No Tomato, remove}; add unrelated food", async () => {
      const m = await h.newMcpCall();
      let r = await m.invoke({ operation: "add", items: [TBB([{ name: "without tomatoes" }])] });
      const id = r.orderId!;
      const line = (await h.readCart(id))[0];
      r = await m.invoke({ operation: "replace_item", targetLineId: line.lineId, items: [TBB([{ name: "No Russian" }])] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      assert.deepEqual((await modNames(id)).sort(), ["Big Boss mods:No Russian", "Big Boss mods:No Tomato"]);
      r = await m.invoke({ operation: "replace_item", targetLineId: line.lineId, items: [TBB([{ name: "No Tomato", remove: true }])] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      assert.deepEqual(await modNames(id), ["Big Boss mods:No Russian"]);
      r = await m.invoke({ operation: "add", items: [{ name: "large fries", quantity: 1 }] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      const lines = await h.dbLines(id);
      assert.equal(lines[0].lineId, line.lineId);
      assert.deepEqual(lines[0].mods, ["Big Boss mods:No Russian[selected]"]);
      assert.equal(lines[0].lineTotal, 1225);
      assert.equal(Number(r.body.total_cents), 1225 + 350);
    });

    await h.check("invalid removals (ingredients the sandwich lacks) leave the cart byte-identical", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [TBB([{ name: "no tomato" }]), { name: "Caramel Cheesecake", quantity: 1 }] });
      const id = r.orderId!;
      const line = (await h.readCart(id))[0];
      const before = await h.snapshot(id);
      for (const mod of [{ name: "no lettuce" }, { name: "Lettuce", remove: true }, { name: "without onions" }, { name: "no pickles" }, { name: "no bacon" }, { name: "no cheese" }]) {
        const x = await m.invoke({ operation: "replace_item", targetLineId: line.lineId, items: [TBB([mod])] });
        assert.equal(x.body.error?.code, "INVALID_MODIFIER", JSON.stringify(mod));
        assert.equal(await h.snapshot(id), before, JSON.stringify(mod));
      }
    });

    // ---------------- defects ----------------
    await h.check("DEFECT positive 'tomato' on a new Turkey Big Boss must not become No Tomato", async () => {
      // strictMatch partial match: query "tomato" -> term "no tomato" endsWith " tomato" (ordering-ai-tools.ts:787)
      for (const mods of [[{ name: "tomato" }], [{ name: "Tomato", group: "Big Boss mods" }]]) {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [TBB(mods)] });
        if (!r.isError && !r.body.pending)
          assert.ok(!(await modNames(r.orderId!)).includes("Big Boss mods:No Tomato"), `${JSON.stringify(mods)} produced No Tomato`);
      }
    });

    await h.check("DEFECT natural restore ('tomato' / 'add tomato' / 'with tomato') on an existing No Tomato line", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [TBB([{ name: "no tomato" }])] });
      const id = r.orderId!;
      const line = (await h.readCart(id))[0];
      const failures: string[] = [];
      for (const name of ["tomato", "add tomato", "with tomato", "Tomatoes"]) {
        const x = await m.invoke({ operation: "replace_item", targetLineId: line.lineId, items: [TBB([{ name }])] });
        if (x.isError || (await modNames(id)).includes("Big Boss mods:No Tomato")) failures.push(`${name}: ${x.body.error?.code || "still No Tomato"}`);
      }
      assert.deepEqual(failures, []);
    });

    await h.check("DEFECT Xtra Russian then 'No Russian' must not leave both on the ticket", async () => {
      const m = await h.newMcpCall();
      let r = await m.invoke({ operation: "add", items: [TBB([{ name: "Xtra Russian" }])] });
      const id = r.orderId!;
      const line = (await h.readCart(id))[0];
      r = await m.invoke({ operation: "replace_item", targetLineId: line.lineId, items: [TBB([{ name: "No Russian" }])] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      const mods = await modNames(id);
      assert.ok(!(mods.includes("Big Boss mods:Xtra Russian") && mods.includes("Big Boss mods:No Russian")), JSON.stringify(mods));
    });

    await h.check("DEFECT sideband readback must carry each modifier's real group (not 'undefined')", async () => {
      const s = h.newSidebandCall();
      const x = await s.invoke({ operation: "add", serviceType: "pickup", items: [TBB([{ name: "no tomato" }])] });
      assert.ok(x.ok, x.error?.message);
      assert.equal(x.compact.lines[0].modifiers[0].group, "Big Boss mods");
    });

    await h.check("[minor] removal phrases with articles ('hold the tomato', 'leave off the tomato', 'hold the russian')", async () => {
      const failures: string[] = [];
      for (const name of ["hold the tomato", "leave off the tomato", "hold the russian"]) {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [TBB([{ name }])] });
        if (r.isError) failures.push(`${name}: ${r.body.error?.code}`);
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

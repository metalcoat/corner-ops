// Regression: fries topping placement, missing size, cross-group alias collisions and atomic
// invalid modifiers. Run: npx tsx scripts/ai-cart-regressions/fries.ts (regressions; failed before the 2026-10-25 fix)
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const mods = async (orderId: string, i = 0) => (await h.dbLines(orderId))[i].mods.map((m: string) => m.replace(/\[.*$/, ""));
  const add = async (items: any[]) => {
    const m = await h.newMcpCall();
    return m.invoke({ operation: "add", items });
  };
  try {
    await h.check("French fries: nacho/gravy default on side; 'on top'/'on the fries'/placement topping go on fries", async () => {
      const cases: Array<[any, string]> = [
        [{ name: "nacho cheese" }, "Fry Option:Nacho Cheese on Side"],
        [{ name: "gravy" }, "Fry Option:Gravy on Side"],
        [{ name: "nacho cheese on top" }, "Fry Option:Nacho Cheese on Fries"],
        [{ name: "gravy on the fries" }, "Fry Option:Gravy on Fries"],
        [{ name: "gravy", placement: "topping" }, "Fry Option:Gravy on Fries"],
        [{ name: "Nacho Cheese", placement: "topping" }, "Fry Option:Nacho Cheese on Fries"],
      ];
      for (const [mod, want] of cases) {
        const r = await add([{ name: "large fries", quantity: 1, modifiers: [mod] }]);
        assert.ok(!r.isError, JSON.stringify(r.body));
        assert.deepEqual(await mods(r.orderId!), [want], JSON.stringify(mod));
      }
    });

    await h.check("missing fry size returns FOLLOW_UP_REQUIRED (MCP + sideband) and leaves an existing cart byte-identical", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [{ name: "Turkey Big Boss", quantity: 1 }] });
      const before = await h.snapshot(r0.orderId!);
      for (const items of [[{ name: "fries", quantity: 1 }], [{ name: "fries", quantity: 1, modifiers: [{ name: "gravy" }] }], [{ name: "curly fries", quantity: 1 }], [{ name: "cheese fries", quantity: 1 }]]) {
        const r = await m.invoke({ operation: "add", items });
        assert.equal(r.body.code, "FOLLOW_UP_REQUIRED", JSON.stringify(r.body));
        assert.equal(r.body.requiredFollowUp, "Small or large?");
        assert.equal(await h.snapshot(r0.orderId!), before);
      }
      const s = h.newSidebandCall();
      const x = await s.invoke({ operation: "add", serviceType: "pickup", items: [{ name: "fries", quantity: 1 }] }, "and fries");
      assert.ok(!x.ok && x.error.code === "FOLLOW_UP_REQUIRED" && x.error.details.pendingItem.missingRequiredFields.includes("size"));
    });

    await h.check("invalid fry modifiers never mutate the cart (add and edit)", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [{ name: "large fries", quantity: 1 }, { name: "Turkey Big Boss", quantity: 1, modifiers: [{ name: "no tomato" }] }] });
      const id = r0.orderId!;
      const c = await h.readCart(id);
      const before = await h.snapshot(id);
      for (const args of [
        { operation: "add", items: [{ name: "large fries", quantity: 1, modifiers: [{ name: "avocado" }] }] },
        { operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Large French Fries", quantity: 1, modifiers: [{ name: "gravy" }, { name: "avocado" }] }] },
        { operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Large French Fries", quantity: 1, modifiers: [{ name: "nacho" }] }] },
        { operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Large French Fries", quantity: 1, modifiers: [{ name: "Gravy on Side", group: "Burger Toppings" }] }] },
      ]) {
        const r = await m.invoke(args);
        assert.ok(r.isError || r.body.pending, JSON.stringify(args));
        assert.equal(await h.snapshot(id), before, JSON.stringify(args));
      }
    });

    // ---------------- defects ----------------
    await h.check("DEFECT curly/waffle fries and tater tots: explicit 'on top'/placement topping must not land on the side", async () => {
      const failures: string[] = [];
      for (const item of ["large curly fries", "large waffle fries", "large tater tots"])
        for (const [mod, want] of [
          [{ name: "nacho cheese on top" }, "Fry Option:Nacho Cheese on Fries"],
          [{ name: "nacho cheese", placement: "topping" }, "Fry Option:Nacho Cheese on Fries"],
          [{ name: "gravy", placement: "topping" }, "Fry Option:Gravy on Fries"],
        ] as Array<[any, string]>) {
          const r = await add([{ name: item, quantity: 1, modifiers: [mod] }]);
          const got = r.isError || r.body.pending ? r.body.error?.code || "PENDING" : (await mods(r.orderId!)).join(",");
          if (got !== want) failures.push(`${item} ${JSON.stringify(mod)} -> ${got}`);
        }
      assert.deepEqual(failures, []);
    });

    await h.check("DEFECT 'Hot Dog w/ SM Fry' + nacho cheese must not silently become a $1.75 fry side cup", async () => {
      const r = await add([{ name: "Hot Dog w/ SM Fry", quantity: 1, modifiers: [{ name: "nacho cheese" }] }]);
      if (!r.isError && !r.body.pending) assert.deepEqual(await mods(r.orderId!), ["Hot Dog Choices:Nacho Cheese"]);
    });

    await h.check("DEFECT sideband: adding a new menu item ('nachos', 'chili') must not be hijacked into a fries modifier", async () => {
      const failures: string[] = [];
      for (const name of ["nachos", "chili"]) {
        const s = h.newSidebandCall();
        let x = await s.invoke({ operation: "add", serviceType: "pickup", items: [{ name: "large fries", quantity: 1 }] }, "");
        assert.ok(x.ok);
        x = await s.invoke({ operation: "add", serviceType: "pickup", items: [{ name, quantity: 1 }] }, "and " + name);
        if (x.ok && x.compact.lines[0].modifiers.length) failures.push(`${name} -> ${x.compact.lines.map((l: any) => l.name + "[" + l.modifiers.map((mm: any) => mm.name).join(",") + "]").join("; ")}`);
      }
      assert.deepEqual(failures, []);
    });

    await h.check("[minor] edit accepts the same placement phrases as add ('nacho cheese on the fries', 'gravy on top')", async () => {
      const failures: string[] = [];
      for (const name of ["nacho cheese on the fries", "gravy on top"]) {
        const m = await h.newMcpCall();
        const r0 = await m.invoke({ operation: "add", items: [{ name: "large fries", quantity: 1 }] });
        const c = await h.readCart(r0.orderId!);
        const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "Large French Fries", quantity: 1, modifiers: [{ name }] }] });
        if (r.isError) failures.push(`${name}: ${r.body.error?.code}`);
      }
      assert.deepEqual(failures, []);
    });

    await h.check("[minor] editing an existing Large fries line with name 'fries' should not re-ask the size", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", items: [{ name: "large fries", quantity: 1 }] });
      const c = await h.readCart(r0.orderId!);
      const r = await m.invoke({ operation: "replace_item", targetLineId: c[0].lineId, items: [{ name: "fries", quantity: 1, modifiers: [{ name: "gravy" }] }] });
      assert.ok(!r.body.pending, `pending: ${r.body.requiredFollowUp}`);
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

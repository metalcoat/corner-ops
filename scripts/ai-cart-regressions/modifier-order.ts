// Regression: spokenCart/compact readback modifier order is nondeterministic after repricing because
// rows written in one transaction share created_at=now() and tie-break on random UUID id
// (openai-phone-sideband.ts:74 and :496). This is why test:ai-cart-safety "call replay" is flaky.
// Run: npx tsx scripts/ai-cart-regressions/modifier-order.ts (regressions; failed before the 2026-10-25 fix)
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  try {
    await h.check("unrelated line modifier order is stable across 8 reprices", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({
        operation: "add",
        items: [
          { name: "large pizza", quantity: 1, modifiers: [{ name: "Pepperoni" }, { name: "Onions", portion: "left_half" }, { name: "Mushrooms" }] },
          { name: "Wings", variant: "12 Wings", quantity: 1, modifiers: [{ name: "Hot" }, { name: "Blue Cheese (4oz)" }, { name: "Celery" }] },
        ],
      });
      const id = r0.orderId!;
      const first = JSON.stringify((await h.readCart(id)).map((l) => l.modifiers?.map((x) => x.name)));
      const seen = new Set([first]);
      for (let i = 0; i < 8; i++) {
        await m.invoke({ operation: "add", items: [{ name: "Caramel Cheesecake", quantity: 1 }] });
        const cur = (await h.readCart(id)).slice(0, 2);
        seen.add(JSON.stringify(cur.map((l) => l.modifiers?.map((x) => x.name))));
      }
      assert.equal(seen.size, 1, [...seen].join("\n"));
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

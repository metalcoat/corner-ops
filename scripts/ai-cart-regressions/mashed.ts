// Regression (failed before the 2026-10-25 fix): a caller asking for "mashed potatoes and gravy" was told
// "we don't have that" — a size-ambiguous item came back as ITEM_NOT_ON_MENU, and "and gravy" was read as
// part of the item name. Run: npx tsx scripts/ai-cart-regressions/mashed.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  try {
    for (const items of [[{ name: "mashed potatoes" }], [{ name: "mashed potatoes and gravy" }], [{ name: "mashed potatoes", modifiers: [{ name: "gravy" }] }]]) {
      await h.check(`MCP ${JSON.stringify(items)} asks small or medium, never 'not on the menu'`, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items });
        assert.ok(r.body.pending === true, JSON.stringify(r.body));
        assert.match(String(r.body.requiredFollowUp), /Small Mashed Potatoes or Medium Mashed Potatoes/);
      });
    }
    for (const name of ["small mashed potatoes with gravy", "medium mashed potatoes and gravy"]) {
      await h.check(`MCP '${name}' adds the side with Gravy`, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: [{ name }] });
        assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
        const lines = await h.dbLines(r.orderId!);
        assert.equal(lines.length, 1);
        assert.match(lines[0].name, /^(Small|Medium) Mashed Potatoes$/);
        assert.ok(lines[0].mods.some((mod: string) => /Gravy\[/.test(mod)), JSON.stringify(lines[0].mods));
      });
    }
  } finally {
    await h.cleanup();
  }
  h.summary();
}
main();

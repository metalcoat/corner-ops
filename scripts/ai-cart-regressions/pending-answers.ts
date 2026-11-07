// Regressions from Chris's dev test calls 2026-11-07 20:15-20:18 (ffeb50b5, 1f6550a0):
// - answers to "What sauce?" / "What dressing?" came as bare reads, so the wings and the salad never went on, and
//   each read cleared the open question;
// - 30 wings rode along with a Hamburger Steak still waiting on a question, and the whole add was refused.
// Run: npx tsx scripts/ai-cart-regressions/pending-answers.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const names = async (orderId: string | null) => (orderId ? (await h.dbLines(orderId)).map((line: any) => `${line.name}|${line.variant}|${line.mods.map((m: string) => m.replace(/\[.*$/, "")).join(",")}`) : []);
  const pending = async (callId: string) => (await h.sql`SELECT pending_item FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`)[0]?.pending_item;
  try {
    await h.check("a sauce answer sent as a bare read adds the wings", async () => {
      const m = await h.newMcpCall();
      await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin", quantity: 1, modifiers: [{ name: "Pepperoni" }] }], customerText: "jumbo pepperoni" });
      const r1 = await m.invoke({ operation: "add", items: [{ name: "Boneless Wings", variant: "10 Wings", quantity: 1 }], customerText: "10 boneless wings" });
      assert.ok(r1.body.pending, JSON.stringify(r1.body));
      const r2 = await m.invoke({ operation: "read", items: [], customerText: "barbecue" });
      assert.ok(!r2.isError, JSON.stringify(r2.body));
      const lines = await names(r2.orderId);
      assert.ok(lines.some((line) => /^Boneless Wings\|10 Wings\|.*BBQ/.test(line)), JSON.stringify(lines));
      assert.ok(!(await pending(m.callId)), "question should be closed");
    });
    await h.check("a dressing answer sent as a bare read adds the salad", async () => {
      const m = await h.newMcpCall();
      const r1 = await m.invoke({ operation: "add", items: [{ name: "Grilled Chicken Salad", quantity: 1 }], customerText: "a grilled chicken salad" });
      assert.ok(r1.body.pending, JSON.stringify(r1.body));
      const r2 = await m.invoke({ operation: "read", items: [], customerText: "Italian" });
      const lines = await names(r2.orderId);
      assert.ok(lines.some((line) => /^Grilled Chicken Sal.*\|.*Italian/.test(line)), JSON.stringify({ lines, body: r2.body }));
    });
    await h.check("a read or another item in between keeps the question open, and reminds the AI", async () => {
      const m = await h.newMcpCall();
      await m.invoke({ operation: "add", items: [{ name: "Pizza", variant: "Jumbo Thin", quantity: 1, modifiers: [{ name: "Sausage" }] }], customerText: "sausage pizza" });
      await m.invoke({ operation: "add", items: [{ name: "Wings", variant: "20 Wings", quantity: 1 }], customerText: "20 wings" });
      await m.invoke({ operation: "read", items: [], customerText: "um" });
      assert.ok(await pending(m.callId), "a non-answer must not close the question");
      const pepsi = await m.invoke({ operation: "add", items: [{ name: "2L Pepsi", quantity: 1 }], customerText: "and a 2 liter Pepsi" });
      assert.ok(String(pepsi.body.still_open || "").includes("Wings"), JSON.stringify(pepsi.body.still_open));
      const done = await m.invoke({ operation: "read", items: [], customerText: "medium" });
      const lines = await names(done.orderId);
      assert.ok(lines.some((line) => /^Wings\|20 Wings\|.*Medium/.test(line)) && lines.some((line) => /Pepsi/.test(line)), JSON.stringify(lines));
    });
    await h.check("wings sent with a Hamburger Steak that needs an answer go on now; the steak follows", async () => {
      const m = await h.newMcpCall();
      const r1 = await m.invoke({
        operation: "add",
        items: [
          { name: "Wings", variant: "30 Wings", quantity: 1, modifiers: [{ name: "Medium" }, { name: "Blue Cheese" }, { name: "Celery" }] },
          { name: "Hamburger Steak", quantity: 1 },
        ],
        customerText: "30 wings medium with blue cheese and celery and a hamburger steak",
      });
      assert.ok(!r1.isError, JSON.stringify(r1.body));
      assert.equal(r1.body.required_follow_up, "Would you like peppers, mushrooms, or onions on that?");
      assert.ok(String(r1.body.held_back || "").includes("Hamburger Steak"), JSON.stringify(r1.body));
      let lines = await names(r1.orderId);
      assert.ok(lines.some((line) => /^Wings\|30 Wings\|.*Medium/.test(line)) && !lines.some((line) => /Hamburger Steak/.test(line)), JSON.stringify(lines));
      await m.invoke({ operation: "add", items: [{ name: "Hamburger Steak", quantity: 1 }], customerText: "peppers and mushrooms" });
      const r3 = await m.invoke({ operation: "read", items: [], customerText: "Italian" });
      lines = await names(r3.orderId);
      assert.equal(lines.filter((line) => /^Wings\|/.test(line)).length, 1, JSON.stringify(lines));
      assert.ok(lines.some((line) => /^Hamburger Steak.*Mushrooms.*Peppers|^Hamburger Steak.*Peppers.*Mushrooms/.test(line) && /Italian/.test(line)), JSON.stringify(lines));
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

// Regression (failed before the 2026-10-25 fixes): how real callers ordered, from replaying recorded calls
// to Corner Deli against the phone AI. Run: npx tsx scripts/ai-cart-regressions/replays.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

const decisions = { burgerFriesDecision: "declined", burgerToppingsDecision: "declined", coldSubCondimentsDecision: "declined", coldSubVegetablesDecision: "declined" };

async function main() {
  const h = await loadHarness();
  const cases: Array<[string, any[], RegExp, RegExp | null]> = [
    ["double bacon cheeseburger", [{ name: "Double Bacon Cheeseburger" }], /^Double Cheeseburger/, /Bacon/],
    ["cheeseburger with swiss cheese", [{ name: "Cheeseburger", modifiers: [{ name: "Swiss Cheese" }] }], /^Cheeseburger/, /Swiss/],
    ["cheeseburger with american cheese", [{ name: "Cheeseburger", modifiers: [{ name: "American Cheese" }] }], /^Cheeseburger/, /America/],
    ["crispy pizza is Dark Cooked", [{ name: "Pizza", variant: "Regular 14 inch", modifiers: [{ name: "Crisp Cooked" }, { name: "Pepperoni" }] }], /^Pizza$/, /Dark Cooked/],
    ["extra russian dressing on a Big Boss", [{ name: "Turkey Big Boss", variant: "Full Sub", modifiers: [{ name: "Russian Dressing", amount: "extra" }] }], /^Turkey Big Boss$/, /Xtra Russian/],
    ["burger 'well done' is accepted (all burgers are cooked well done)", [{ name: "Cheeseburger (1/4lbs)", modifiers: [{ name: "Bacon" }, { name: "Well Done" }] }], /^Cheeseburger/, /Bacon/],
    ["julienne salad, no tomatoes", [{ name: "Julienne Salad", modifiers: [{ name: "Tomatoes", remove: true }, { name: "Ranch" }] }], /^Julienne/, /No Tomato/],
    ["'fish burger' is the Fishburger", [{ name: "fish burger" }], /^Fishburger$/, null],
    ["mild sauce 4oz on side is the mild cup", [{ name: "Mild Sauce 4oz On Side" }], /Mild/, null],
    ["large loaded fries and a 4oz ranch", [{ name: "Large Loaded Fries" }, { name: "Ranch", variant: "4oz" }], /^Large French Fries$/, /Loaded/],
  ];
  try {
    for (const [label, items, name, mod] of cases) {
      await h.check(label, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items, ...decisions });
        assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
        const line = (await h.dbLines(r.orderId!))[0];
        assert.match(line.name, name);
        if (mod) assert.ok(line.mods.some((value: string) => mod.test(value)), JSON.stringify(line.mods));
      });
    }
    // Owner 2026-10-25: read back "two liter", and a poutine fry as "Large Fry Poutine".
    await h.check("cart lines carry how to say them", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ name: "2L Pepsi" }, { name: "large poutine" }], ...decisions });
      assert.ok(!r.isError && !r.body.pending, JSON.stringify(r.body));
      const says = (r.body.lines || []).map((line: any) => line.say);
      assert.ok(says.some((say: string) => /^two liter Pepsi/i.test(say)), JSON.stringify(says));
      assert.ok(says.includes("Large Fry Poutine"), JSON.stringify(says));
    });
    await h.check("steak sandwich is the Steak sub", async () => {
      const m = await h.newMcpCall();
      const r = await m.invoke({ operation: "add", items: [{ name: "Steak Sandwich", variant: "Full Sub" }], ...decisions });
      assert.ok(!r.isError, JSON.stringify(r.body));
    });
  } finally {
    await h.cleanup();
  }
  h.summary();
}
main();

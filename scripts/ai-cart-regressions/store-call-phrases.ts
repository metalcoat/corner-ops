// Real caller wording from 2,232 deli phone calls (Sep 1 to Nov 8 2026; redacted transcripts on the store server,
// call ids below). Each case sends the item the way a caller said it, as the voice model would, and checks what the
// order system resolves it to. Only short order phrases are kept here, no names, numbers or addresses.
// Run: npx tsx scripts/ai-cart-regressions/store-call-phrases.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

type Mod = { name: string; group?: string; portion?: "whole" | "left_half" | "right_half" };
type Case = { call: string; said: string; items: Array<{ name: string; variant?: string; quantity?: number; modifiers?: Mod[] }>; item: RegExp; variant?: RegExp; mods?: RegExp[]; noMods?: RegExp[] };

const CASES: Case[] = [
  { call: "20260902-230829-2665", said: "20 hot wings, extra crispy, extra saucy, blue cheese and celery", items: [{ name: "Wings", variant: "20 Wings", modifiers: [{ name: "Hot" }, { name: "extra crispy" }, { name: "blue cheese" }, { name: "celery" }] }], item: /^Wings$/, variant: /20 Wings/, mods: [/Hot/, /Extra Crispy/, /Blue Cheese/, /Celery/] },
  { call: "20260905-234241-3293", said: "12 medium wings extra crispy", items: [{ name: "Wings", variant: "12 Wings", modifiers: [{ name: "Medium" }, { name: "extra crispy" }] }], item: /^Wings$/, variant: /12/, mods: [/Medium/, /Extra Crispy/] },
  { call: "20260906-224255-3359", said: "a dozen mild wings extra crispy", items: [{ name: "Wings", variant: "12 Wings", modifiers: [{ name: "mild" }, { name: "crispy" }] }], item: /^Wings$/, mods: [/Mild/, /Extra Crispy/] },
  { call: "20260905-234241-3293", said: "a medium pepperoni and sausage", items: [{ name: "Pizza", variant: "medium", modifiers: [{ name: "pepperoni" }, { name: "sausage" }] }], item: /^Pizza$/, variant: /Regular|14/, mods: [/Pepperoni/, /Sausage/] },
  { call: "20260902-003059-2428", said: "a small pizza", items: [{ name: "Pizza", variant: "small", modifiers: [{ name: "Pepperoni" }] }], item: /^Pizza$/, variant: /Small/ },
  { call: "20260906-214832-3353", said: "medium pizza, pepperoni on the whole thing, ham on half", items: [{ name: "Pizza", variant: "medium", modifiers: [{ name: "pepperoni", portion: "whole" }, { name: "ham", portion: "left_half" }] }], item: /^Pizza$/, mods: [/Pepperoni/, /Ham/] },
  { call: "store-calls", said: "a large thin crust", items: [{ name: "Pizza", variant: "large thin crust", modifiers: [{ name: "Pepperoni" }] }], item: /^Pizza$/, variant: /Jumbo Thin/ },
  { call: "store-calls", said: "large pepperoni, well done", items: [{ name: "Pizza", variant: "Jumbo Thin", modifiers: [{ name: "pepperoni" }, { name: "well done" }] }], item: /^Pizza$/, mods: [/Dark Cooked/], noMods: [/Regular Cooked/] },
  { call: "20260904-001811-2922", said: "a whole steak", items: [{ name: "whole steak" }], item: /^Steak$/, variant: /Full Sub/ },
  { call: "20260912-230506-4633", said: "the whole steak sub", items: [{ name: "whole steak sub" }], item: /^Steak$/, variant: /Full Sub/ },
  { call: "20260905-195320-3250", said: "a whole steak, American cheese, mayonnaise and onion", items: [{ name: "Steak", variant: "whole", modifiers: [{ name: "American" }, { name: "mayonnaise" }, { name: "onion" }] }], item: /^Steak$/, variant: /Full Sub/ },
  { call: "store-calls", said: "a half turkey", items: [{ name: "half turkey" }], item: /^Turkey$/, variant: /1\/2 Sub/ },
  { call: "20261013-221648-11051", said: "two whole Philly steak and cheese", items: [{ name: "Philly steak and cheese", variant: "whole", quantity: 2 }], item: /^Steak$/, variant: /Full Sub/ },
  { call: "20261026-210212-13735", said: "a Philly cheesesteak sub", items: [{ name: "Philly cheesesteak" }], item: /^Steak$/ },
  { call: "store-calls", said: "a cheesesteak", items: [{ name: "cheesesteak" }], item: /^Steak$/ },
  { call: "20260912-002758-4549", said: "cheesy garlic bread", items: [{ name: "cheesy garlic bread" }], item: /^Cheesy Breadsticks$/ },
  { call: "20260926-233258-7385", said: "cheese bread", items: [{ name: "cheese bread" }], item: /^Cheesy Breadsticks$/ },
  { call: "20261008-225112-10184", said: "cheesy bread", items: [{ name: "cheesy bread" }], item: /^Cheesy Breadsticks$/ },
  { call: "20260904-001811-2922", said: "a medium potato salad", items: [{ name: "potato salad", variant: "medium" }], item: /^Potato Salad$/, variant: /Medium/ },
  { call: "store-calls", said: "a medium macaroni salad", items: [{ name: "macaroni salad", variant: "medium" }], item: /^Mac Salad$/, variant: /Medium/ },
  { call: "store-calls", said: "a small coleslaw", items: [{ name: "coleslaw", variant: "small" }], item: /^Cole Slaw$/, variant: /Small/ },
  { call: "20261008-225112-10184", said: "the loaded fries", items: [{ name: "loaded fries", variant: "large" }], item: /French Fries/, mods: [/Loaded/] },
  { call: "20260903-005031-2675", said: "a large poutine", items: [{ name: "large poutine" }], item: /Large French Fries/, mods: [/Poutine/] },
  { call: "20260901-001013-2137", said: "an order of mozzarella sticks", items: [{ name: "mozzarella sticks" }], item: /Mozzarella/ },
  { call: "20260901-001013-2137", said: "a cheeseburger", items: [{ name: "cheeseburger" }], item: /Cheeseburger/ },
  { call: "store-calls", said: "a bacon cheeseburger", items: [{ name: "bacon cheeseburger" }], item: /Cheeseburger/, mods: [/Bacon/] },
  { call: "20260912-230506-4633", said: "an order of pizza logs", items: [{ name: "pizza logs" }], item: /^Pizza Logs$/ },
  { call: "store-calls", said: "a 2 liter Pepsi", items: [{ name: "two liter Pepsi" }], item: /2L Pepsi/ },
  { call: "store-calls", said: "a chicken quesadilla", items: [{ name: "chicken quesadilla" }], item: /^Chicken Quesadilla$/ },
  { call: "store-calls", said: "spaghetti with garlic bread", items: [{ name: "Spaghetti", modifiers: [{ name: "garlic bread" }] }], item: /^Spaghetti$/, mods: [/Garlic Bread/] },
];

async function main() {
  const h = await loadHarness();
  try {
    for (const row of CASES) {
      await h.check(`${row.said} (${row.call})`, async () => {
        const m = await h.newMcpCall();
        const r = await m.invoke({ operation: "add", items: row.items.map((item) => ({ quantity: 1, ...item })), customerText: row.said });
        if (r.body.pending || r.isError) {
          // A follow-up question is fine as long as the right item was understood.
          const pendingId = r.body.details?.pendingItem?.actualMenuItemId;
          assert.ok(pendingId, `not understood: ${JSON.stringify(r.body).slice(0, 300)}`);
          const name = String((await h.sql`SELECT name FROM ordering_menu_items WHERE id=${pendingId}`)[0]?.name || "");
          assert.match(name, row.item, `understood as ${name}`);
          if (row.variant) {
            const variant = String((await h.sql`SELECT name FROM ordering_menu_item_variants WHERE id=${r.body.details?.pendingItem?.actualVariantId || null}`)[0]?.name || "");
            assert.match(variant, row.variant, `size ${variant}`);
          }
          return;
        }
        const lines = await h.dbLines(r.orderId!);
        const line = lines.find((row2: any) => row.item.test(row2.name));
        assert.ok(line, `got ${JSON.stringify(lines.map((l: any) => l.name))}`);
        if (row.variant) assert.match(String(line.variant), row.variant, `size ${line.variant}`);
        const mods = line.mods.map((mod: string) => mod.replace(/\[.*$/, ""));
        for (const want of row.mods || []) assert.ok(mods.some((mod: string) => want.test(mod)), `${want} missing from ${JSON.stringify(mods)}`);
        for (const not of row.noMods || []) assert.ok(!mods.some((mod: string) => not.test(mod)), `${not} should be gone: ${JSON.stringify(mods)}`);
      });
    }
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

#!/usr/bin/env node
// Burger "Deluxe" (Chris 2026-11-06): burgers come plain; lettuce, tomato and onion are $0.25 once for any or
// all of them. Checks the shared price rule, the server's draft pricing and order snapshots, the send-time
// price re-check, and the AI phone (price_order) on the dev database. Every order is rolled back.
// Run after scripts/configure-burger-deluxe.ts: npx tsx scripts/burger-deluxe-validate.ts
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:burger-deluxe-validation";

async function main() {
  const [{ getSql, withTransaction }, { groupSelectionChargeCents }, { createDraftOrder }, { submitDraftOrder, OrderConflictError }, { priceSpokenOrder }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ordering-modifier-pricing"),
    import("../src/lib/ordering-orders"),
    import("../src/lib/ordering-order-lifecycle"),
    import("../src/lib/ordering-ai-tools"),
  ]);
  const results: Record<string, unknown> = {};

  // The shared rule the POS, online page and server all use.
  assert.deepEqual([0, 1, 2, 3].map((count) => groupSelectionChargeCents(25, count)), [0, 25, 25, 25]);
  results.sharedRule = true;

  const sql = getSql();
  const burgers = (await sql`
    SELECT item.id, item.name, grp.id AS deluxe_id, grp.selection_charge_cents,
           array_agg(opt.id ORDER BY opt.sort_order) AS option_ids, array_agg(opt.name ORDER BY opt.sort_order) AS option_names
    FROM ordering_menu_items item
    JOIN ordering_menu_item_modifier_groups link ON link.item_id = item.id
    JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active AND grp.name = 'Deluxe' AND grp.business = 'Corner Deli'
    JOIN ordering_modifier_options opt ON opt.group_id = grp.id AND opt.active
    WHERE item.active
    GROUP BY item.id, item.name, grp.id, grp.selection_charge_cents
    ORDER BY item.name
  `) as Array<{ id: string; name: string; deluxe_id: string; selection_charge_cents: number; option_ids: string[]; option_names: string[] }>;
  assert.ok(burgers.length >= 12, `Deluxe is on ${burgers.length} burgers; run scripts/configure-burger-deluxe.ts`);
  assert.deepEqual(burgers[0].option_names, ["Lettuce", "Tomato", "Onion"]);
  assert.equal(Number(burgers[0].selection_charge_cents), 25);
  const leftovers = await sql`
    SELECT opt.name FROM ordering_modifier_options opt JOIN ordering_modifier_groups grp ON grp.id = opt.group_id
    WHERE grp.business = 'Corner Deli' AND grp.name = 'Burger Toppings' AND opt.active AND opt.name IN ('Lettuce', 'Tomatoes', 'Raw Onions')`;
  assert.equal(leftovers.length, 0, "Lettuce/tomatoes/raw onions are still free in Burger Toppings");
  results.burgers = burgers.map((burger) => burger.name);

  const hamburger = burgers.find((burger) => burger.name === "Hamburger") || burgers[0];
  const required = async (itemId: string) => {
    // Meal Fry Choice and similar required groups: take their first option (no charge expected).
    const rows = await sql`
      SELECT grp.id, (array_agg(opt.id ORDER BY opt.sort_order, opt.name))[1] AS first_option
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active AND grp.min_selections > 0
      JOIN ordering_modifier_options opt ON opt.group_id = grp.id AND opt.active AND opt.available AND opt.price_delta_cents = 0
      LEFT JOIN ordering_modifier_presentation_overrides p ON p.item_id = link.item_id AND p.group_id = grp.id
      WHERE link.item_id = ${itemId} AND COALESCE(p.context, 'ordinary') = 'ordinary'
      GROUP BY grp.id`;
    return Object.fromEntries(rows.map((row) => [String(row.id), [String(row.first_option)]]));
  };
  const base = await required(hamburger.id);
  const actor = { id: "deluxe-validation", name: "Deluxe validation", type: "employee" as const, role: "owner" as const };

  try {
    await withTransaction(async () => {
      const sql = getSql(); // the transaction's own connection: uncommitted orders are only visible here
      const lineFor = async (deluxe: string[], extra: Record<string, string[]> = {}) => {
        const order = await createDraftOrder({
          business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: actor.id, customerFirstName: "Deluxe", callerPhone: "3155550142",
          items: [{ itemId: hamburger.id, modifierSelections: { ...base, ...extra, [hamburger.deluxe_id]: deluxe } }],
        });
        const line = (await sql`SELECT id, modifier_total_cents, line_total_cents FROM ordering_order_items WHERE order_id = ${order.id}`)[0];
        const mods = await sql`SELECT option_name_snapshot, unit_price_delta_cents FROM ordering_order_item_modifiers WHERE order_item_id = ${line.id} AND group_id = ${hamburger.deluxe_id} AND selection_state = 'selected'`;
        return { order, modifierTotal: Number(line.modifier_total_cents), deluxeMods: mods.map((m) => [String(m.option_name_snapshot), Number(m.unit_price_delta_cents)]) };
      };

      const plain = await lineFor([]);
      assert.equal(plain.modifierTotal, 0, "a plain burger has no Deluxe charge");
      const counts: Record<string, number> = {};
      for (const pick of [[0], [1], [2], [0, 1], [1, 2], [0, 1, 2]]) {
        const line = await lineFor(pick.map((index) => hamburger.option_ids[index]));
        const label = pick.map((index) => hamburger.option_names[index]).join("+");
        assert.equal(line.modifierTotal, 25, `${label} charged ${line.modifierTotal}`);
        assert.equal(line.deluxeMods.filter(([, cents]) => cents === 25).length, 1, `${label}: the 25¢ must sit on exactly one option ${JSON.stringify(line.deluxeMods)}`);
        counts[label] = line.modifierTotal;
      }
      results.serverCharges = { none: plain.modifierTotal, ...counts };

      // Mushrooms (+$0.25 on its own) stays separate: all three Deluxe + mushrooms = $0.50.
      const toppings = (await sql`SELECT grp.id, opt.id AS mushrooms FROM ordering_menu_item_modifier_groups link JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.name = 'Burger Toppings' JOIN ordering_modifier_options opt ON opt.group_id = grp.id AND opt.name = 'Mushrooms' AND opt.active WHERE link.item_id = ${hamburger.id}`)[0];
      const withMushrooms = await lineFor(hamburger.option_ids, { [String(toppings.id)]: [String(toppings.mushrooms)] });
      assert.equal(withMushrooms.modifierTotal, 50);
      results.deluxePlusMushrooms = withMushrooms.modifierTotal;

      // The send-time price check accepts the charge, and refuses a draft priced before the fee changed.
      const sent = await lineFor(hamburger.option_ids);
      const submitted = await submitDraftOrder(String(sent.order.id), "Corner Deli", actor, { approved: true, reason: "deluxe validation" });
      assert.equal(submitted.order.status, "sent_to_kitchen");
      const stale = await lineFor([hamburger.option_ids[1]]);
      await sql`UPDATE ordering_modifier_groups SET selection_charge_cents = 50 WHERE id = ${hamburger.deluxe_id}`;
      await assert.rejects(
        submitDraftOrder(String(stale.order.id), "Corner Deli", actor, { approved: true, reason: "deluxe validation" }),
        (error: unknown) => error instanceof OrderConflictError && /modifier price/i.test((error as Error).message),
      );
      await sql`UPDATE ordering_modifier_groups SET selection_charge_cents = 25 WHERE id = ${hamburger.deluxe_id}`;
      results.sendCheck = { acceptsCharge: true, refusesChangedFee: true };

      // AI phone: spoken toppings land in Deluxe and are charged once; "cheeseburger deluxe" keeps mayo and pickles.
      const aiActor = { id: "openai:deluxe-validation", name: "Corner Deli AI Phone", type: "employee" as const, role: "employee" as const };
      const aiLine = async (items: any[]) => {
        const draft: any = await priceSpokenOrder({ business: "Corner Deli", actor: aiActor, service: "pickup", items, firstName: "Deluxe", callerPhone: "3155550142" });
        const line = (await sql`SELECT id, item_name_snapshot, modifier_total_cents FROM ordering_order_items WHERE order_id = ${draft.id}`)[0];
        const mods = await sql`SELECT group_name_snapshot, option_name_snapshot FROM ordering_order_item_modifiers WHERE order_item_id = ${line.id} AND selection_state = 'selected' ORDER BY option_name_snapshot`;
        return { name: String(line.item_name_snapshot), modifierTotal: Number(line.modifier_total_cents), mods: mods.map((m) => `${m.group_name_snapshot}:${m.option_name_snapshot}`) };
      };
      const ai: Record<string, unknown> = {};
      const one = await aiLine([{ name: "Hamburger", modifiers: [{ name: "onion" }, { name: "No Side" }] }]);
      assert.deepEqual(one.mods.filter((m) => m.startsWith("Deluxe:")), ["Deluxe:Onion"]);
      assert.equal(one.modifierTotal, 25);
      ai.onion = one;
      const all = await aiLine([{ name: "Cheeseburger", modifiers: [{ name: "American" }, { name: "lettuce" }, { name: "tomatoes" }, { name: "onions" }, { name: "ketchup" }, { name: "No Side" }] }]);
      assert.deepEqual(all.mods.filter((m) => m.startsWith("Deluxe:")), ["Deluxe:Lettuce", "Deluxe:Onion", "Deluxe:Tomato"]);
      assert.equal(all.modifierTotal, 25, JSON.stringify(all));
      ai.lettuceTomatoOnionKetchup = all;
      const deluxe = await aiLine([{ name: "Cheeseburger Deluxe", modifiers: [{ name: "American" }, { name: "No Side" }] }]);
      assert.deepEqual(deluxe.mods.filter((m) => m.startsWith("Deluxe:")), ["Deluxe:Lettuce", "Deluxe:Onion", "Deluxe:Tomato"]);
      assert.ok(deluxe.mods.includes("Burger Toppings:Mayo") && deluxe.mods.includes("Burger Toppings:Pickles"), JSON.stringify(deluxe));
      assert.equal(deluxe.modifierTotal, 25, JSON.stringify(deluxe));
      ai.cheeseburgerDeluxe = deluxe;
      const asModifier = await aiLine([{ name: "Hamburger", modifiers: [{ name: "deluxe" }, { name: "No Side" }] }]);
      assert.equal(asModifier.modifierTotal, 25, JSON.stringify(asModifier));
      ai.deluxeAsModifier = asModifier;
      results.aiPhone = ai;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }

  const parm = (await sql`SELECT item.base_price_cents, array_agg(variant.base_price_cents) AS variants FROM ordering_menu_items item LEFT JOIN ordering_menu_item_variants variant ON variant.item_id = item.id AND variant.active WHERE item.business = 'Corner Deli' AND item.active AND LOWER(item.name) = 'pepperoni chicken parmesan sub' GROUP BY item.id`)[0];
  assert.equal(Number(parm.base_price_cents), 1250);
  assert.ok((parm.variants as number[]).every((cents) => cents === null || Number(cents) === 1250));
  results.pepperoniParmCents = 1250;

  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

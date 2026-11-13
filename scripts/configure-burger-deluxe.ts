#!/usr/bin/env node
// Burgers come plain. Lettuce, tomato and onion move out of Burger Toppings into a "Deluxe" group that is
// charged $0.25 once for any or all of them (Chris 2026-11-06: "Deluxe" - Lettuce, Tomato, Onion: any or
// all +$0.25). Needs migration 0038 (ordering_modifier_groups.selection_charge_cents).
// Rerunnable: an existing Deluxe group, its options and links are updated in place, never duplicated.
//
//   npx tsx scripts/configure-burger-deluxe.ts                 dev
//   VALIDATION_TARGET=staging npx tsx scripts/configure-burger-deluxe.ts
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const BUSINESS = "Corner Deli";
const GROUP_NAME = "Deluxe";
const PROMPT = '"Deluxe" - Lettuce, Tomato, Onion: any or all +$0.25';
const CHARGE_CENTS = 25;
const OPTIONS = ["Lettuce", "Tomato", "Onion"];
// The same toppings as they were named in Burger Toppings; they now live only in Deluxe.
const MOVED_TOPPINGS = ["Lettuce", "Tomatoes", "Raw Onions"];
const ACTOR = "configure-burger-deluxe";
const REASON = 'Chris 2026-11-06: burgers come plain; "Deluxe" lettuce, tomato, onion any or all +$0.25';

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const result = await withTransaction(async () => {
    const sql = getSql();
    const audit = (targetType: string, targetId: string, field: string, previous: unknown, next: unknown) =>
      sql`INSERT INTO ordering_menu_override_audit (id, business, actor_id, target_type, target_id, field_name, previous_value, new_value, reason)
          VALUES (${randomUUID()}, ${BUSINESS}, ${ACTOR}, ${targetType}, ${targetId}, ${field}, ${previous === null ? null : JSON.stringify(previous)}::jsonb, ${JSON.stringify(next)}::jsonb, ${REASON})`;

    // Every active burger: the items that carry a Burger Toppings group.
    const burgers = (await sql`
      SELECT item.id, item.name, link.group_id AS toppings_group_id, link.sort_order AS toppings_sort
      FROM ordering_menu_items item
      JOIN ordering_menu_item_modifier_groups link ON link.item_id = item.id
      JOIN ordering_modifier_groups grp ON grp.id = link.group_id
      WHERE item.business = ${BUSINESS} AND item.active = TRUE
        AND grp.business = ${BUSINESS} AND grp.name = 'Burger Toppings' AND grp.active = TRUE
      ORDER BY item.name
    `) as Array<{ id: string; name: string; toppings_group_id: string; toppings_sort: number }>;
    if (!burgers.length) throw new Error("No active burgers with a Burger Toppings group were found.");

    let group = (await sql`SELECT id, prompt, min_selections, max_selections, selection_charge_cents, active FROM ordering_modifier_groups WHERE business = ${BUSINESS} AND name = ${GROUP_NAME} ORDER BY created_at LIMIT 1`)[0];
    if (!group) {
      const id = randomUUID();
      await sql`INSERT INTO ordering_modifier_groups (id, business, name, prompt, min_selections, max_selections, allow_option_quantity, selection_charge_cents, active, sort_order)
                VALUES (${id}, ${BUSINESS}, ${GROUP_NAME}, ${PROMPT}, 0, ${OPTIONS.length}, FALSE, ${CHARGE_CENTS}, TRUE, 4)`;
      await audit("modifier_group", id, "create", null, { name: GROUP_NAME, prompt: PROMPT, selectionChargeCents: CHARGE_CENTS });
      group = { id };
    } else if (group.prompt !== PROMPT || Number(group.min_selections) !== 0 || Number(group.max_selections) !== OPTIONS.length || Number(group.selection_charge_cents) !== CHARGE_CENTS || !group.active) {
      await sql`UPDATE ordering_modifier_groups SET prompt = ${PROMPT}, min_selections = 0, max_selections = ${OPTIONS.length}, allow_option_quantity = FALSE, selection_charge_cents = ${CHARGE_CENTS}, active = TRUE, updated_at = NOW() WHERE id = ${group.id}`;
      await audit("modifier_group", group.id, "update", { prompt: group.prompt, selectionChargeCents: Number(group.selection_charge_cents), active: group.active }, { prompt: PROMPT, selectionChargeCents: CHARGE_CENTS, active: true });
    }
    const groupId = String(group.id);

    for (const [index, name] of OPTIONS.entries()) {
      const option = (await sql`SELECT id, price_delta_cents, active, available, sort_order FROM ordering_modifier_options WHERE group_id = ${groupId} AND name = ${name}`)[0];
      if (!option) {
        const id = randomUUID();
        await sql`INSERT INTO ordering_modifier_options (id, group_id, name, price_delta_cents, available, active, sort_order) VALUES (${id}, ${groupId}, ${name}, 0, TRUE, TRUE, ${index + 1})`;
        await audit("modifier_option", id, "create", null, { name, priceDeltaCents: 0 });
      } else if (Number(option.price_delta_cents) !== 0 || !option.active || !option.available || Number(option.sort_order) !== index + 1) {
        await sql`UPDATE ordering_modifier_options SET price_delta_cents = 0, active = TRUE, available = TRUE, sort_order = ${index + 1}, updated_at = NOW() WHERE id = ${option.id}`;
        await audit("modifier_option", String(option.id), "update", { priceDeltaCents: Number(option.price_delta_cents), active: option.active }, { priceDeltaCents: 0, active: true });
      }
    }

    // Deluxe sits just ahead of Burger Toppings on every burger (the toppings link moves down one; the
    // next group, Burger Bacon, is ten or more places further on).
    const linked: string[] = [];
    for (const burger of burgers) {
      const existing = (await sql`SELECT id FROM ordering_menu_item_modifier_groups WHERE item_id = ${burger.id} AND group_id = ${groupId}`)[0];
      if (existing) continue;
      await sql`UPDATE ordering_menu_item_modifier_groups SET sort_order = ${Number(burger.toppings_sort) + 1} WHERE item_id = ${burger.id} AND group_id = ${burger.toppings_group_id}`;
      await sql`INSERT INTO ordering_menu_item_modifier_groups (id, item_id, group_id, sort_order) VALUES (${randomUUID()}, ${burger.id}, ${groupId}, ${Number(burger.toppings_sort)})`;
      await audit("menu_item", burger.id, "link_modifier_group", null, { group: GROUP_NAME });
      linked.push(burger.name);
    }

    // Lettuce, tomatoes and raw onions come off Burger Toppings so they can only be ordered (and charged)
    // through Deluxe. Old orders keep their snapshots; the options are only switched off.
    const retired = (await sql`
      UPDATE ordering_modifier_options option
      SET active = FALSE, updated_at = NOW()
      FROM ordering_modifier_groups grp
      WHERE grp.id = option.group_id AND grp.business = ${BUSINESS} AND grp.name = 'Burger Toppings'
        AND option.name = ANY(${MOVED_TOPPINGS}) AND option.active = TRUE
      RETURNING option.id, option.name, grp.id AS group_id
    `) as Array<{ id: string; name: string; group_id: string }>;
    for (const option of retired) await audit("modifier_option", option.id, "active", { active: true }, { active: false, movedTo: GROUP_NAME });

    return {
      groupId,
      prompt: PROMPT,
      selectionChargeCents: CHARGE_CENTS,
      burgers: burgers.map((burger) => burger.name),
      newlyLinked: linked,
      retiredFromBurgerToppings: retired.map((option) => `${option.name} (${option.group_id})`),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

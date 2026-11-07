#!/usr/bin/env node
// Gives every sandwich the same "Make it a combo" side choice the burgers have,
// copied from the Hamburger: its combo trigger group and the fry topping groups that depend on it.
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingMenuOverrideSchema } = await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  const result = await withTransaction(async () => {
    const sql = getSql();
    const template = (await sql`
      SELECT item.id FROM ordering_menu_items item JOIN ordering_menu_categories category ON category.id=item.category_id
      WHERE item.business='Corner Deli' AND item.active AND item.name='Hamburger' AND category.name LIKE '%/ Burgers' LIMIT 1`)[0];
    if (!template) throw new Error("The Hamburger to copy the combo from was not found.");
    const groups = await sql`
      SELECT p.group_id FROM ordering_modifier_presentation_overrides p
      WHERE p.item_id=${template.id} AND (p.context='combo_trigger' OR p.parent_group_id IN (SELECT group_id FROM ordering_modifier_presentation_overrides WHERE item_id=${template.id} AND context='combo_trigger'))`;
    if (!groups.length) throw new Error("The Hamburger has no combo to copy.");
    const groupIds = groups.map((row) => String(row.group_id));
    const sandwiches = await sql`
      SELECT item.id,item.name FROM ordering_menu_items item JOIN ordering_menu_categories category ON category.id=item.category_id
      WHERE item.business='Corner Deli' AND item.active AND category.name LIKE '%/ Sandwiches' ORDER BY item.name`;
    for (const sandwich of sandwiches) {
      await sql`
        INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order)
        SELECT gen_random_uuid(),${sandwich.id},link.group_id,(SELECT COALESCE(MAX(sort_order),0) FROM ordering_menu_item_modifier_groups WHERE item_id=${sandwich.id})+1+link.sort_order
        FROM ordering_menu_item_modifier_groups link WHERE link.item_id=${template.id} AND link.group_id=ANY(${groupIds}::uuid[])
        ON CONFLICT(item_id,group_id) DO NOTHING`;
      await sql`
        INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,parent_group_id,parent_option_ids,sort_order,updated_by,behavior,included_choice_count,supports_intensity,print_order,header_modifier,suppress_default_on_ticket,presentation_style,component_key,component_label,component_order,dependency_scope)
        SELECT ${sandwich.id},group_id,context,parent_group_id,parent_option_ids,sort_order,'sandwich-combos',behavior,included_choice_count,supports_intensity,print_order,header_modifier,suppress_default_on_ticket,presentation_style,component_key,component_label,component_order,dependency_scope
        FROM ordering_modifier_presentation_overrides WHERE item_id=${template.id} AND group_id=ANY(${groupIds}::uuid[])
        ON CONFLICT(item_id,group_id) DO UPDATE SET context=EXCLUDED.context,parent_group_id=EXCLUDED.parent_group_id,parent_option_ids=EXCLUDED.parent_option_ids,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
    }
    return { copiedFrom: "Hamburger", groups: groupIds.length, sandwiches: sandwiches.map((row) => String(row.name)) };
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

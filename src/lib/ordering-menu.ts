import { getSql } from "@/lib/db";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";

type CategoryRow = { id: string; name: string; display_name: string; parent_id: string | null; presentation_only: boolean; sort_order: number };
type ItemRow = { id: string; category_id: string; name: string; description: string; sku: string; base_price_cents: number; taxable: boolean; available: boolean; sort_order: number };
type ModifierRow = {
  item_id: string; group_id: string; group_name: string; prompt: string;
  min_selections: number; max_selections: number; allow_option_quantity: boolean;
  group_sort: number; option_id: string | null; option_name: string | null;
  price_delta_cents: number | null; option_available: boolean | null; option_sort: number | null;
  default_selected: boolean | null; included_quantity: number | null;
};
type ComboRow = {
  item_id: string; combo_id: string; combo_name: string; combo_prompt: string;
  combo_base_price_delta_cents: number; combo_sort: number; group_id: string | null;
  group_name: string | null; group_prompt: string | null; min_selections: number | null;
  max_selections: number | null; group_sort: number | null; option_id: string | null;
  option_name: string | null; option_menu_item_id: string | null;
  option_price_delta_cents: number | null; option_available: boolean | null; option_sort: number | null;
};

export type OrderingModifierOptionView = { id: string; name: string; priceDeltaCents: number; available: boolean; defaultSelected: boolean; includedQuantity: number };
export type OrderingModifierGroupView = { id: string; name: string; prompt: string; minSelections: number; maxSelections: number; allowOptionQuantity: boolean; options: OrderingModifierOptionView[] };
export type OrderingComboOptionView = { id: string; name: string; menuItemId: string | null; priceDeltaCents: number; available: boolean };
export type OrderingComboGroupView = { id: string; name: string; prompt: string; minSelections: number; maxSelections: number; options: OrderingComboOptionView[] };
export type OrderingComboView = { id: string; name: string; prompt: string; basePriceDeltaCents: number; groups: OrderingComboGroupView[] };
export type OrderingMenuItemView = { id: string; categoryId: string; name: string; description: string; sku: string; basePriceCents: number; taxable: boolean; available: boolean; modifiers: OrderingModifierGroupView[]; combos: OrderingComboView[] };
export type OrderingMenuCategoryView = { id: string; name: string; displayName: string; parentId: string | null; presentationOnly: boolean; sortOrder: number; items: OrderingMenuItemView[] };

export async function orderingMenu(business: OrderingBusiness): Promise<OrderingMenuCategoryView[]> {
  await ensureOrderingChannelSchema();
  const sql = getSql();
  const categories = (await sql`SELECT id, name, display_name, parent_id, presentation_only, sort_order FROM ordering_menu_categories WHERE business = ${business} AND active = TRUE ORDER BY sort_order, name`) as CategoryRow[];
  const items = (await sql`SELECT id, category_id, name, description, sku, base_price_cents, taxable, available, sort_order FROM ordering_menu_items WHERE business = ${business} AND active = TRUE ORDER BY sort_order, name`) as ItemRow[];
  const modifiers = (await sql`
    SELECT link.item_id, grp.id AS group_id, grp.name AS group_name, grp.prompt,
      grp.min_selections, grp.max_selections, grp.allow_option_quantity, link.sort_order AS group_sort,
      opt.id AS option_id, opt.name AS option_name,
      COALESCE(def.price_delta_override_cents, opt.price_delta_cents) AS price_delta_cents,
      COALESCE(def.available_override, opt.available) AS option_available,
      opt.sort_order AS option_sort, COALESCE(def.default_selected, FALSE) AS default_selected,
      COALESCE(def.included_quantity, 0) AS included_quantity
    FROM ordering_menu_item_modifier_groups link
    JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active = TRUE
    LEFT JOIN ordering_modifier_options opt ON opt.group_id = grp.id AND opt.active = TRUE
    LEFT JOIN ordering_menu_item_modifier_defaults def ON def.item_id = link.item_id AND def.option_id = opt.id AND def.active = TRUE
    JOIN ordering_menu_items item ON item.id = link.item_id
    WHERE item.business = ${business} AND item.active = TRUE
    ORDER BY link.item_id, link.sort_order, grp.sort_order, opt.sort_order, opt.name
  `) as ModifierRow[];
  const combos = (await sql`
    SELECT item_combo.item_id, combo.id AS combo_id, combo.name AS combo_name, combo.prompt AS combo_prompt,
      combo.base_price_delta_cents AS combo_base_price_delta_cents, item_combo.sort_order AS combo_sort,
      grp.id AS group_id, grp.name AS group_name, grp.prompt AS group_prompt, grp.min_selections,
      grp.max_selections, grp.sort_order AS group_sort, opt.id AS option_id, opt.name AS option_name,
      opt.menu_item_id AS option_menu_item_id, opt.price_delta_cents AS option_price_delta_cents,
      opt.available AS option_available, opt.sort_order AS option_sort
    FROM ordering_menu_item_combos item_combo
    JOIN ordering_combo_definitions combo ON combo.id = item_combo.combo_id AND combo.active = TRUE
    JOIN ordering_menu_items item ON item.id = item_combo.item_id
    LEFT JOIN ordering_combo_groups grp ON grp.combo_id = combo.id AND grp.active = TRUE
    LEFT JOIN ordering_combo_options opt ON opt.group_id = grp.id AND opt.active = TRUE
    WHERE item.business = ${business} AND item.active = TRUE AND item_combo.active = TRUE
    ORDER BY item_combo.item_id, item_combo.sort_order, grp.sort_order, opt.sort_order, opt.name
  `) as ComboRow[];

  const itemMap = new Map<string, OrderingMenuItemView>();
  for (const item of items) itemMap.set(item.id, { id: item.id, categoryId: item.category_id, name: item.name, description: item.description, sku: item.sku, basePriceCents: Number(item.base_price_cents), taxable: Boolean(item.taxable), available: Boolean(item.available), modifiers: [], combos: [] });

  const modifierGroupMap = new Map<string, OrderingModifierGroupView>();
  for (const row of modifiers) {
    const item = itemMap.get(row.item_id); if (!item) continue;
    const key = `${row.item_id}:${row.group_id}`;
    let group = modifierGroupMap.get(key);
    if (!group) {
      group = { id: row.group_id, name: row.group_name, prompt: row.prompt, minSelections: Number(row.min_selections), maxSelections: Number(row.max_selections), allowOptionQuantity: Boolean(row.allow_option_quantity), options: [] };
      modifierGroupMap.set(key, group); item.modifiers.push(group);
    }
    if (row.option_id && row.option_name) group.options.push({ id: row.option_id, name: row.option_name, priceDeltaCents: Number(row.price_delta_cents ?? 0), available: Boolean(row.option_available), defaultSelected: Boolean(row.default_selected), includedQuantity: Number(row.included_quantity ?? 0) });
  }

  const comboMap = new Map<string, OrderingComboView>();
  const comboGroupMap = new Map<string, OrderingComboGroupView>();
  for (const row of combos) {
    const item = itemMap.get(row.item_id); if (!item) continue;
    const comboKey = `${row.item_id}:${row.combo_id}`;
    let combo = comboMap.get(comboKey);
    if (!combo) { combo = { id: row.combo_id, name: row.combo_name, prompt: row.combo_prompt, basePriceDeltaCents: Number(row.combo_base_price_delta_cents), groups: [] }; comboMap.set(comboKey, combo); item.combos.push(combo); }
    if (!row.group_id || !row.group_name) continue;
    const groupKey = `${comboKey}:${row.group_id}`;
    let group = comboGroupMap.get(groupKey);
    if (!group) { group = { id: row.group_id, name: row.group_name, prompt: row.group_prompt || "", minSelections: Number(row.min_selections ?? 0), maxSelections: Number(row.max_selections ?? 1), options: [] }; comboGroupMap.set(groupKey, group); combo.groups.push(group); }
    if (row.option_id && row.option_name) group.options.push({ id: row.option_id, name: row.option_name, menuItemId: row.option_menu_item_id, priceDeltaCents: Number(row.option_price_delta_cents ?? 0), available: Boolean(row.option_available) });
  }

  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    displayName: category.display_name || category.name,
    parentId: category.parent_id,
    presentationOnly: Boolean(category.presentation_only),
    sortOrder: Number(category.sort_order),
    items: items.filter((item) => item.category_id === category.id).map((item) => itemMap.get(item.id)).filter((item): item is OrderingMenuItemView => Boolean(item)),
  }));
}

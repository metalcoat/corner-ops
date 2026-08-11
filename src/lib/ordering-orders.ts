import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import type { OrderingBusiness, OrderSource, ServiceType } from "@/lib/ordering-core";
import { calculateLineTotalCents, validateModifierRequirements } from "@/lib/ordering-core";

export type ConfiguredOrderItemInput = {
  itemId: string;
  quantity?: number;
  modifierSelections?: Record<string, string[]>;
  comboId?: string | null;
  comboSelections?: Record<string, string[]>;
  specialInstructions?: string;
};

export type CreateDraftOrderInput = {
  business: OrderingBusiness;
  source: OrderSource;
  serviceType: ServiceType;
  customerId?: string | null;
  callerPhone?: string;
  createdBy: string;
  items?: ConfiguredOrderItemInput[];
};

type CounterRow = { value: string | number };
type ItemRow = {
  id: string;
  name: string;
  base_price_cents: number;
  available: boolean;
};
type ModifierRow = {
  group_id: string;
  group_name: string;
  min_selections: number;
  max_selections: number;
  option_id: string | null;
  option_name: string | null;
  option_available: boolean | null;
  price_delta_cents: number | null;
  default_selected: boolean | null;
};
type ComboRow = {
  combo_id: string;
  combo_name: string;
  base_price_delta_cents: number;
  group_id: string | null;
  group_name: string | null;
  min_selections: number | null;
  max_selections: number | null;
  option_id: string | null;
  option_name: string | null;
  option_available: boolean | null;
  option_price_delta_cents: number | null;
};
type OrderRow = {
  id: string;
  business: OrderingBusiness;
  display_number: string;
  status: string;
  payment_status: string;
  service_type: ServiceType;
  version: number;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  paid_cents: number;
  amount_due_cents: number;
  created_at: string | Date;
  updated_at: string | Date;
};

function positiveQuantity(value: number | undefined): number {
  const quantity = Math.trunc(value ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Item quantity must be a positive integer.");
  return quantity;
}

async function nextOrderNumber(business: OrderingBusiness): Promise<string> {
  const rows = (await getSql()`
    INSERT INTO ordering_business_counters (business, counter_name, next_value)
    VALUES (${business}, 'order_number', 2)
    ON CONFLICT (business, counter_name)
    DO UPDATE SET next_value = ordering_business_counters.next_value + 1, updated_at = NOW()
    RETURNING next_value - 1 AS value
  `) as CounterRow[];
  return String(rows[0].value);
}

async function addConfiguredItem(orderId: string, business: OrderingBusiness, input: ConfiguredOrderItemInput): Promise<void> {
  const sql = getSql();
  const quantity = positiveQuantity(input.quantity);
  const itemRows = (await sql`
    SELECT id, name, base_price_cents, available
    FROM ordering_menu_items
    WHERE id = ${input.itemId} AND business = ${business} AND active = TRUE
    LIMIT 1
  `) as ItemRow[];
  const item = itemRows[0];
  if (!item) throw new Error("Menu item was not found for this business.");
  if (!item.available) throw new Error(`${item.name} is currently unavailable.`);

  const modifierRows = (await sql`
    SELECT
      grp.id AS group_id,
      grp.name AS group_name,
      grp.min_selections,
      grp.max_selections,
      opt.id AS option_id,
      opt.name AS option_name,
      opt.available AS option_available,
      COALESCE(def.price_delta_override_cents, opt.price_delta_cents) AS price_delta_cents,
      COALESCE(def.default_selected, FALSE) AS default_selected
    FROM ordering_menu_item_modifier_groups link
    JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active = TRUE
    LEFT JOIN ordering_modifier_options opt ON opt.group_id = grp.id AND opt.active = TRUE
    LEFT JOIN ordering_menu_item_modifier_defaults def
      ON def.item_id = link.item_id AND def.option_id = opt.id AND def.active = TRUE
    WHERE link.item_id = ${item.id}
    ORDER BY link.sort_order, grp.sort_order, opt.sort_order, opt.name
  `) as ModifierRow[];

  const groups = new Map<string, { name: string; min: number; max: number; rows: ModifierRow[] }>();
  for (const row of modifierRows) {
    if (!groups.has(row.group_id)) {
      groups.set(row.group_id, {
        name: row.group_name,
        min: Number(row.min_selections),
        max: Number(row.max_selections),
        rows: [],
      });
    }
    groups.get(row.group_id)!.rows.push(row);
  }

  const modifierSelections = input.modifierSelections || {};
  const modifierIssues = validateModifierRequirements(
    Array.from(groups.entries()).map(([groupId, group]) => ({
      groupId,
      groupName: group.name,
      minSelections: group.min,
      maxSelections: group.max,
      selectedCount: (modifierSelections[groupId] || []).length,
    })),
  );
  if (modifierIssues.length) {
    const names = modifierIssues.map((issue) => issue.groupName).join(", ");
    throw new Error(`Required modifier choices are incomplete or invalid: ${names}.`);
  }

  let modifierUnitDeltaCents = 0;
  const modifierSnapshots: Array<{
    groupId: string;
    optionId: string;
    groupName: string;
    optionName: string;
    state: "selected" | "removed";
    priceDeltaCents: number;
  }> = [];

  for (const [groupId, group] of groups) {
    const selected = new Set(modifierSelections[groupId] || []);
    const validOptionIds = new Set(group.rows.filter((row) => row.option_id).map((row) => row.option_id!));
    for (const selectedId of selected) {
      if (!validOptionIds.has(selectedId)) throw new Error(`An invalid modifier option was supplied for ${group.name}.`);
    }

    for (const row of group.rows) {
      if (!row.option_id || !row.option_name) continue;
      const isSelected = selected.has(row.option_id);
      if (isSelected && !row.option_available) throw new Error(`${row.option_name} is currently unavailable.`);
      if (isSelected) {
        const delta = Number(row.price_delta_cents ?? 0);
        modifierUnitDeltaCents += delta;
        modifierSnapshots.push({
          groupId,
          optionId: row.option_id,
          groupName: group.name,
          optionName: row.option_name,
          state: "selected",
          priceDeltaCents: delta,
        });
      } else if (row.default_selected) {
        modifierSnapshots.push({
          groupId,
          optionId: row.option_id,
          groupName: group.name,
          optionName: row.option_name,
          state: "removed",
          priceDeltaCents: 0,
        });
      }
    }
  }

  let comboUnitDeltaCents = 0;
  let comboNameSnapshot = "";
  const comboSnapshots: Array<{
    comboId: string;
    groupId: string;
    optionId: string;
    comboName: string;
    groupName: string;
    optionName: string;
    priceDeltaCents: number;
  }> = [];

  if (input.comboId) {
    const comboRows = (await sql`
      SELECT
        combo.id AS combo_id,
        combo.name AS combo_name,
        combo.base_price_delta_cents,
        grp.id AS group_id,
        grp.name AS group_name,
        grp.min_selections,
        grp.max_selections,
        opt.id AS option_id,
        opt.name AS option_name,
        opt.available AS option_available,
        opt.price_delta_cents AS option_price_delta_cents
      FROM ordering_menu_item_combos item_combo
      JOIN ordering_combo_definitions combo ON combo.id = item_combo.combo_id AND combo.active = TRUE
      LEFT JOIN ordering_combo_groups grp ON grp.combo_id = combo.id AND grp.active = TRUE
      LEFT JOIN ordering_combo_options opt ON opt.group_id = grp.id AND opt.active = TRUE
      WHERE item_combo.item_id = ${item.id}
        AND item_combo.combo_id = ${input.comboId}
        AND item_combo.active = TRUE
      ORDER BY grp.sort_order, opt.sort_order, opt.name
    `) as ComboRow[];
    if (!comboRows.length) throw new Error("The selected combo is not available for this item.");

    comboNameSnapshot = comboRows[0].combo_name;
    comboUnitDeltaCents += Number(comboRows[0].base_price_delta_cents);
    const comboGroups = new Map<string, { name: string; min: number; max: number; rows: ComboRow[] }>();
    for (const row of comboRows) {
      if (!row.group_id || !row.group_name) continue;
      if (!comboGroups.has(row.group_id)) {
        comboGroups.set(row.group_id, {
          name: row.group_name,
          min: Number(row.min_selections ?? 0),
          max: Number(row.max_selections ?? 1),
          rows: [],
        });
      }
      comboGroups.get(row.group_id)!.rows.push(row);
    }

    const selections = input.comboSelections || {};
    for (const [groupId, group] of comboGroups) {
      const selected = selections[groupId] || [];
      if (selected.length < group.min || selected.length > group.max) {
        throw new Error(`Required combo choice is incomplete: ${group.name}.`);
      }
      const valid = new Map(group.rows.filter((row) => row.option_id).map((row) => [row.option_id!, row]));
      for (const optionId of selected) {
        const row = valid.get(optionId);
        if (!row || !row.option_name) throw new Error(`An invalid combo option was supplied for ${group.name}.`);
        if (!row.option_available) throw new Error(`${row.option_name} is currently unavailable.`);
        const delta = Number(row.option_price_delta_cents ?? 0);
        comboUnitDeltaCents += delta;
        comboSnapshots.push({
          comboId: input.comboId,
          groupId,
          optionId,
          comboName: comboNameSnapshot,
          groupName: group.name,
          optionName: row.option_name,
          priceDeltaCents: delta,
        });
      }
    }
  }

  const lineTotalCents = calculateLineTotalCents({
    quantity,
    unitPriceCents: Number(item.base_price_cents),
    modifierUnitDeltaCents,
    comboUnitDeltaCents,
  });
  const orderItemId = randomUUID();
  await sql`
    INSERT INTO ordering_order_items (
      id, order_id, item_id, item_name_snapshot, quantity, unit_price_cents,
      modifier_total_cents, combo_name_snapshot, combo_total_cents,
      line_total_cents, special_instructions, sort_order
    ) VALUES (
      ${orderItemId}, ${orderId}, ${item.id}, ${item.name}, ${quantity}, ${Number(item.base_price_cents)},
      ${modifierUnitDeltaCents}, ${comboNameSnapshot}, ${comboUnitDeltaCents},
      ${lineTotalCents}, ${String(input.specialInstructions || "")},
      (SELECT COUNT(*)::INTEGER FROM ordering_order_items WHERE order_id = ${orderId})
    )
  `;

  for (const modifier of modifierSnapshots) {
    await sql`
      INSERT INTO ordering_order_item_modifiers (
        id, order_item_id, group_id, option_id, group_name_snapshot, option_name_snapshot,
        quantity, unit_price_delta_cents, selection_state
      ) VALUES (
        ${randomUUID()}, ${orderItemId}, ${modifier.groupId}, ${modifier.optionId},
        ${modifier.groupName}, ${modifier.optionName}, 1, ${modifier.priceDeltaCents}, ${modifier.state}
      )
    `;
  }

  for (const combo of comboSnapshots) {
    await sql`
      INSERT INTO ordering_order_item_combo_selections (
        id, order_item_id, combo_id, group_id, option_id, combo_name_snapshot,
        group_name_snapshot, option_name_snapshot, price_delta_cents
      ) VALUES (
        ${randomUUID()}, ${orderItemId}, ${combo.comboId}, ${combo.groupId}, ${combo.optionId},
        ${combo.comboName}, ${combo.groupName}, ${combo.optionName}, ${combo.priceDeltaCents}
      )
    `;
  }
}

async function recalculateOrder(orderId: string): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE ordering_orders
    SET subtotal_cents = totals.subtotal_cents,
        total_cents = GREATEST(0, totals.subtotal_cents - discount_cents + tax_cents + tip_cents),
        amount_due_cents = GREATEST(0, totals.subtotal_cents - discount_cents + tax_cents + tip_cents - paid_cents),
        version = version + 1,
        updated_at = NOW()
    FROM (
      SELECT COALESCE(SUM(line_total_cents), 0)::INTEGER AS subtotal_cents
      FROM ordering_order_items
      WHERE order_id = ${orderId}
    ) totals
    WHERE ordering_orders.id = ${orderId}
  `;
}

export async function createDraftOrder(input: CreateDraftOrderInput): Promise<OrderRow> {
  await ensureOrderingPosSchema();
  const sql = getSql();
  const id = randomUUID();
  const displayNumber = await nextOrderNumber(input.business);
  const items = input.items || [];

  await sql`
    INSERT INTO ordering_orders (
      id, business, source, customer_id, caller_phone, status, payment_status,
      service_type, version, display_number, created_by
    ) VALUES (
      ${id}, ${input.business}, ${input.source}, ${input.customerId || null}, ${String(input.callerPhone || "")},
      'draft', 'unpaid', ${input.serviceType}, 1, ${displayNumber}, ${input.createdBy}
    )
  `;

  try {
    for (const item of items) await addConfiguredItem(id, input.business, item);
    if (items.length) await recalculateOrder(id);
    await sql`
      INSERT INTO ordering_order_events (id, order_id, order_version, event_type, actor_type, actor_id, details)
      VALUES (
        ${randomUUID()}, ${id}, ${items.length ? 2 : 1}, 'order_created',
        ${input.source === "pos" ? "employee" : input.source === "web" ? "web" : input.source === "ai_phone" ? "ai" : "system"},
        ${input.createdBy},
        CAST(${JSON.stringify({ source: input.source, serviceType: input.serviceType, itemCount: items.length })} AS jsonb)
      )
    `;
  } catch (error) {
    await sql`DELETE FROM ordering_orders WHERE id = ${id}`;
    throw error;
  }

  const rows = (await sql`
    SELECT id, business, display_number, status, payment_status, service_type, version,
           subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, paid_cents,
           amount_due_cents, created_at, updated_at
    FROM ordering_orders
    WHERE id = ${id}
    LIMIT 1
  `) as OrderRow[];
  return rows[0];
}

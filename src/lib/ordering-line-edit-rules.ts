/** Pure rules for EDIT on a line already saved on an order: pre-filling the item screen and the kitchen's CHANGED ticket. */
import type { PizzaToppingAmount, PizzaToppingPortion, PizzaToppingSelection } from "./ordering-pizza-toppings";

export type SavedModifierRow = {
  group_id: string;
  option_id: string;
  group_name_snapshot?: string | null;
  option_name_snapshot?: string | null;
  option_print_name_snapshot?: string | null;
  quantity?: number | null;
  amount?: string | null;
  selection_state?: string | null;
  pizza_topping_portion?: string | null;
  pizza_topping_amount?: string | null;
  print_on_ticket?: boolean | null;
};
export type SavedComboRow = { combo_id: string; group_id: string; option_id: string };
export type SavedLine = {
  item_id: string;
  variant_id?: string | null;
  item_name_snapshot: string;
  variant_name_snapshot?: string | null;
  quantity: number;
  cancelled_quantity?: number | null;
  special_instructions?: string | null;
  modifiers?: SavedModifierRow[];
  combo_selections?: SavedComboRow[];
};

export type SavedLineConfiguration = {
  itemId: string;
  variantId: string | null;
  quantity: number;
  modifierSelections: Record<string, string[]>;
  modifierQuantities: Record<string, number>;
  modifierAmounts: Record<string, "light" | "normal" | "heavy">;
  modifierDeclines: string[];
  pizzaToppings: PizzaToppingSelection[];
  comboId: string | null;
  comboSelections: Record<string, string[]>;
  specialInstructions: string;
};

/** The choices a saved line was rung with, in the shape the item screen and the order API take. */
export function savedLineConfiguration(line: SavedLine): SavedLineConfiguration {
  const modifierSelections: Record<string, string[]> = {};
  const modifierQuantities: Record<string, number> = {};
  const modifierAmounts: Record<string, "light" | "normal" | "heavy"> = {};
  const modifierDeclines: string[] = [];
  const pizzaToppings: PizzaToppingSelection[] = [];
  for (const row of line.modifiers || []) {
    const state = String(row.selection_state || "selected");
    if (state === "declined_included") {
      if (!modifierDeclines.includes(row.group_id)) modifierDeclines.push(row.group_id);
      continue;
    }
    if (state !== "selected" && state !== "extra") continue;
    if (row.pizza_topping_portion) {
      if (!pizzaToppings.some((topping) => topping.modifierOptionId === row.option_id && topping.portion === row.pizza_topping_portion))
        pizzaToppings.push({ modifierOptionId: row.option_id, portion: row.pizza_topping_portion as PizzaToppingPortion, amount: (row.pizza_topping_amount || "regular") as PizzaToppingAmount });
      continue;
    }
    const selected = (modifierSelections[row.group_id] ||= []);
    if (!selected.includes(row.option_id)) selected.push(row.option_id);
    // Included and extra units of one option are stored as separate rows.
    modifierQuantities[row.option_id] = (modifierQuantities[row.option_id] || 0) + Math.max(1, Number(row.quantity || 1));
    if (row.amount === "light" || row.amount === "heavy") modifierAmounts[row.option_id] = row.amount;
  }
  const comboSelections: Record<string, string[]> = {};
  let comboId: string | null = null;
  for (const row of line.combo_selections || []) {
    comboId = row.combo_id;
    const selected = (comboSelections[row.group_id] ||= []);
    if (!selected.includes(row.option_id)) selected.push(row.option_id);
  }
  return {
    itemId: line.item_id,
    variantId: line.variant_id || null,
    quantity: Number(line.quantity) - Number(line.cancelled_quantity || 0),
    modifierSelections,
    modifierQuantities,
    modifierAmounts,
    modifierDeclines,
    pizzaToppings,
    comboId,
    comboSelections,
    specialInstructions: String(line.special_instructions || ""),
  };
}

export type LineSnapshot = { quantity: number; itemName: string; variantName: string; modifiers: string[]; note: string };

const pizzaAmountLabel: Record<string, string> = { extra: "EXTRA ", double_extra: "2X EXTRA ", triple_extra: "3X EXTRA " };
const pizzaPortionLabel: Record<string, string> = { left_half: "LEFT ", right_half: "RIGHT " };

/** What the kitchen sees of a line, in words, so two versions of it can be compared. */
export function lineSnapshot(line: SavedLine): LineSnapshot {
  const counts = new Map<string, number>();
  for (const row of line.modifiers || []) {
    if (row.print_on_ticket === false) continue;
    const state = String(row.selection_state || "selected");
    // The menu name, not the printer short name: a line only gets its print names at Send, so a fresh one would look changed.
    const name = String(row.option_name_snapshot || "").toUpperCase();
    let label: string;
    if (state === "declined_included") label = `NO ${String(row.group_name_snapshot || "CHOICE").toUpperCase()}`;
    else if (state === "removed") label = `NO ${name}`;
    else if (row.pizza_topping_portion) label = `${pizzaPortionLabel[String(row.pizza_topping_portion)] || ""}${pizzaAmountLabel[String(row.pizza_topping_amount)] || ""}${name}`;
    else label = `${row.amount === "light" ? "LIGHT " : row.amount === "heavy" ? "EXTRA " : ""}${name}`;
    counts.set(label, (counts.get(label) || 0) + (state === "selected" || state === "extra" ? Math.max(1, Number(row.quantity || 1)) : 1));
  }
  return {
    quantity: Number(line.quantity) - Number(line.cancelled_quantity || 0),
    itemName: String(line.item_name_snapshot || "").toUpperCase(),
    variantName: String(line.variant_name_snapshot || "").toUpperCase(),
    modifiers: Array.from(counts, ([label, count]) => (count > 1 ? `${count}x ${label}` : label)).sort(),
    note: String(line.special_instructions || "").trim(),
  };
}

export function sameLine(before: LineSnapshot, after: LineSnapshot) {
  return before.quantity === after.quantity && before.variantName === after.variantName && before.note === after.note && before.itemName === after.itemName && before.modifiers.join("\n") === after.modifiers.join("\n");
}

/** The short kitchen ticket for an edited line: "** CHANGED ** 1x PIZZA", then only what changed. */
export function changedTicketLines(before: LineSnapshot, after: LineSnapshot): string[] {
  const lines = [`** CHANGED ** ${after.quantity}x ${after.itemName}${after.variantName && before.variantName === after.variantName ? ` (${after.variantName})` : ""}`];
  if (before.variantName !== after.variantName) lines.push(`  SIZE: ${before.variantName || "-"} -> ${after.variantName || "-"}`);
  if (before.quantity !== after.quantity) lines.push(`  QTY: ${before.quantity} -> ${after.quantity}`);
  for (const modifier of before.modifiers) if (!after.modifiers.includes(modifier)) lines.push(`  - ${modifier}`);
  for (const modifier of after.modifiers) if (!before.modifiers.includes(modifier)) lines.push(`  + ${modifier}`);
  if (before.note !== after.note) lines.push(after.note ? `  NOTE: ${after.note}` : "  NOTE REMOVED");
  return lines;
}

/** One line of the order history: "1x Pizza (Jumbo Thin): Pepperoni -> 1x Pizza (Jumbo Thick): Sausage". */
export function describeSnapshot(snapshot: LineSnapshot) {
  const choices = [...snapshot.modifiers, ...(snapshot.note ? [`note: ${snapshot.note}`] : [])];
  return `${snapshot.quantity}x ${snapshot.itemName}${snapshot.variantName ? ` (${snapshot.variantName})` : ""}${choices.length ? `: ${choices.join(", ")}` : ""}`;
}

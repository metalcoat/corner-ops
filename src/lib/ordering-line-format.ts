import { formatPizzaTopping, type PizzaToppingAmount, type PizzaToppingPortion } from "@/lib/ordering-pizza-toppings";
import { formatModifierIntensity } from "@/lib/ordering-modifier-intensity";

const kitchenPortions: Record<string, string> = {
  "small french fries": "7oz", "large french fries": "11oz",
  "small curly fries": "6oz", "large curly fries": "9oz",
  "small tater tots": "7oz", "large tater tots": "11oz",
  "onion rings": "7oz", "small waffle fries": "6oz", "large waffle fries": "9oz",
};

export function kitchenPortionName(itemName: string) {
  const key = itemName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const portion = kitchenPortions[key];
  return portion && !itemName.toLocaleLowerCase().includes(portion) ? `${itemName} (${portion})` : itemName;
}

export type OrderModifierPresentation = {
  option_name_snapshot: string;
  quantity: number;
  selection_state: string;
  pizza_topping_portion?: PizzaToppingPortion | null;
  pizza_topping_amount?: PizzaToppingAmount | null;
  amount?: "light" | "normal" | "heavy" | null;
  print_on_ticket?: boolean;
  print_order_snapshot?: number;
};

export function pizzaToppingColumns(modifiers: OrderModifierPresentation[]) {
  const columns: Record<PizzaToppingPortion, string[]> = { left_half: [], whole: [], right_half: [] };
  modifiers
    .filter((modifier) => modifier.print_on_ticket !== false && modifier.pizza_topping_portion && modifier.pizza_topping_amount)
    .toSorted((left, right) => Number(left.print_order_snapshot || 0) - Number(right.print_order_snapshot || 0) || left.option_name_snapshot.localeCompare(right.option_name_snapshot))
    .forEach((modifier) => {
      const portion = modifier.pizza_topping_portion as PizzaToppingPortion;
      columns[portion].push(formatPizzaTopping(modifier.option_name_snapshot, "whole", modifier.pizza_topping_amount as PizzaToppingAmount, "ticket"));
    });
  return columns;
}

export function hasSplitPizzaToppings(modifiers: OrderModifierPresentation[]) {
  return modifiers.some((modifier) => modifier.print_on_ticket !== false && (modifier.pizza_topping_portion === "left_half" || modifier.pizza_topping_portion === "right_half"));
}

export function formatOrderModifier(modifier: OrderModifierPresentation, style: "display" | "ticket" = "display"): string {
  if (style === "ticket" && modifier.print_on_ticket === false) return "";
  if (modifier.pizza_topping_portion && modifier.pizza_topping_amount) {
    return formatPizzaTopping(modifier.option_name_snapshot, modifier.pizza_topping_portion, modifier.pizza_topping_amount, style);
  }
  const value = modifier.selection_state === "removed"
    ? `NO ${modifier.option_name_snapshot}`
    : modifier.selection_state === "declined_included" ? "NO INCLUDED CHOICE"
    : `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${formatModifierIntensity(modifier.option_name_snapshot, modifier.amount || "normal")}`;
  return style === "ticket" ? value.toUpperCase() : value;
}

export function formatOrderItemName(itemName: string, variantName: string, style: "display" | "ticket" = "display"): string {
  const value = variantName ? `${variantName} ${itemName}` : itemName;
  return style === "ticket" ? value.toUpperCase() : value;
}

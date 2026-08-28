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

const kitchenKey = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function kitchenItemFamily(itemName: string, categoryName = "") {
  const item = kitchenKey(itemName);
  const category = kitchenKey(categoryName);
  if (/^\d\d-/.test(categoryName)) return categoryName;
  if (item.includes("pizza") && !item.startsWith("pizza log")) return "00-pizza";
  if (item.includes("wing")) return "10-wings";
  if (category.includes("pizza and wing")) return "15-pizza-sides";
  if (category.includes("sub") || item.includes("big boss")) return "20-subs";
  if (category.includes("burger") || category.includes("sandwich") || category.includes("tender") || category.includes("kid")) return "30-grill";
  if (category.includes("appetizer") || category.includes("side dish")) return "40-apps-sides";
  if (category.includes("meal") || category.includes("fish") || category.includes("italian") || category.includes("mexican")) return "50-meals";
  if (category.includes("salad")) return "60-salads";
  if (category.includes("drink") || category.includes("soda") || category.includes("liter") || category.includes("chip") || category.includes("arizona")) return "90-drinks";
  return `70-${category || "other"}`;
}

export function compareKitchenItems(
  left: { item_name_snapshot: string; category_name?: string; sort_order?: number },
  right: { item_name_snapshot: string; category_name?: string; sort_order?: number },
) {
  return kitchenItemFamily(left.item_name_snapshot, left.category_name).localeCompare(kitchenItemFamily(right.item_name_snapshot, right.category_name))
    || Number(left.sort_order || 0) - Number(right.sort_order || 0);
}

export function pizzaKitchenModifierOrder(modifier: Pick<OrderModifierPresentation, "option_name_snapshot" | "print_order_snapshot"> & { group_name_snapshot?: string }) {
  const configured = Number(modifier.print_order_snapshot || 0);
  if (configured) return configured;
  const name = kitchenKey(modifier.option_name_snapshot);
  const group = kitchenKey(modifier.group_name_snapshot || "");
  if (group.includes("pizza sauce")) return 10;
  if (name.includes("light sauce")) return 15;
  if (name.includes("extra sauce")) return 20;
  const names = ["pepperoni", "mushroom", "pepper", "onion", "ham", "bacon", "tomato", "black olive", "jalapeno", "chicken", "broccoli", "hot pepper", "meatball"];
  const rank = names.findIndex((candidate) => name.includes(candidate));
  if (rank >= 0) return 30 + rank * 10;
  if (name.includes("extra cheese")) return 900;
  if (name.includes("sausage")) return 910;
  return 800;
}

export function kitchenModifierOrder(
  item: { item_name_snapshot: string; category_name?: string },
  modifier: Pick<OrderModifierPresentation, "option_name_snapshot" | "print_order_snapshot"> & { group_name_snapshot?: string },
) {
  const configured = Number(modifier.print_order_snapshot || 0);
  if (configured) return configured;
  const family = kitchenItemFamily(item.item_name_snapshot, item.category_name);
  if (family === "00-pizza") return pizzaKitchenModifierOrder(modifier);
  if (family === "20-subs") {
    const name = kitchenKey(modifier.option_name_snapshot);
    const names = ["mayonnaise", "mayo", "russian", "oil", "lettuce", "tomato", "onion", "hot pepper", "ranch", "bacon", "a1 sauce", "parm shaker", "oregano shaker", "jalapeno", "pickle", "mustard", "mushroom", "black olive", "not toasted", "extra sauce", "double cheese", "double meat"];
    const rank = names.findIndex((candidate) => name.includes(candidate));
    if (rank >= 0) return (rank + 1) * 10;
  }
  return configured;
}

export function comparePizzaKitchenModifiers(left: OrderModifierPresentation & { group_name_snapshot?: string }, right: OrderModifierPresentation & { group_name_snapshot?: string }) {
  return pizzaKitchenModifierOrder(left) - pizzaKitchenModifierOrder(right)
    || left.option_name_snapshot.localeCompare(right.option_name_snapshot);
}

export function pizzaToppingColumns(modifiers: OrderModifierPresentation[]) {
  const columns: Record<PizzaToppingPortion, string[]> = { left_half: [], whole: [], right_half: [] };
  modifiers
    .filter((modifier) => modifier.print_on_ticket !== false && modifier.pizza_topping_portion && modifier.pizza_topping_amount)
    .toSorted(comparePizzaKitchenModifiers)
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

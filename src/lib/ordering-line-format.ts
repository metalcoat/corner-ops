import { formatPizzaTopping, type PizzaToppingAmount, type PizzaToppingPortion } from "@/lib/ordering-pizza-toppings";

export type OrderModifierPresentation = {
  option_name_snapshot: string;
  quantity: number;
  selection_state: string;
  pizza_topping_portion?: PizzaToppingPortion | null;
  pizza_topping_amount?: PizzaToppingAmount | null;
};

export function formatOrderModifier(modifier: OrderModifierPresentation, style: "display" | "ticket" = "display"): string {
  if (modifier.pizza_topping_portion && modifier.pizza_topping_amount) {
    return formatPizzaTopping(modifier.option_name_snapshot, modifier.pizza_topping_portion, modifier.pizza_topping_amount, style);
  }
  const value = modifier.selection_state === "removed"
    ? `NO ${modifier.option_name_snapshot}`
    : `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${modifier.option_name_snapshot}`;
  return style === "ticket" ? value.toUpperCase() : value;
}

export function formatOrderItemName(itemName: string, variantName: string, style: "display" | "ticket" = "display"): string {
  const value = variantName ? `${variantName} ${itemName}` : itemName;
  return style === "ticket" ? value.toUpperCase() : value;
}

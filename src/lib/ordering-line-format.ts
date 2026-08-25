import { formatPizzaTopping, type PizzaToppingAmount, type PizzaToppingPortion } from "@/lib/ordering-pizza-toppings";
import { formatModifierIntensity } from "@/lib/ordering-modifier-intensity";

export type OrderModifierPresentation = {
  option_name_snapshot: string;
  quantity: number;
  selection_state: string;
  pizza_topping_portion?: PizzaToppingPortion | null;
  pizza_topping_amount?: PizzaToppingAmount | null;
  amount?: "light" | "normal" | "heavy" | null;
  print_on_ticket?: boolean;
};

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

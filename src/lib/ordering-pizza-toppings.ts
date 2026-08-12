export type PizzaToppingPortion = "whole" | "left_half" | "right_half";
export type PizzaToppingAmount = "regular" | "extra";

export type PizzaToppingSelection = {
  modifierOptionId: string;
  portion: PizzaToppingPortion;
  amount: PizzaToppingAmount;
};

export function pizzaToppingPriceCents(basePriceCents: number, portion: PizzaToppingPortion, amount: PizzaToppingAmount): number {
  if (!Number.isSafeInteger(basePriceCents) || basePriceCents < 0) throw new Error("Pizza topping price must be non-negative integer cents.");
  const amountMultiplier = amount === "extra" ? 2 : 1;
  // Half-cent results round up. Imported Corner Deli topping prices are even,
  // but this makes the future pricing contract deterministic for odd cents.
  return portion === "whole"
    ? basePriceCents * amountMultiplier
    : Math.floor((basePriceCents * amountMultiplier + 1) / 2);
}

export function normalizePizzaToppings(selections: PizzaToppingSelection[]): PizzaToppingSelection[] {
  const result: PizzaToppingSelection[] = [];
  for (const selection of selections) {
    if (!result.some((item) => item.modifierOptionId === selection.modifierOptionId && item.portion === selection.portion && item.amount === selection.amount)) result.push({ ...selection });
  }
  for (const optionId of new Set(result.map((item) => item.modifierOptionId))) {
    for (const amount of ["regular", "extra"] as const) {
      const left = result.findIndex((item) => item.modifierOptionId === optionId && item.portion === "left_half" && item.amount === amount);
      const right = result.findIndex((item) => item.modifierOptionId === optionId && item.portion === "right_half" && item.amount === amount);
      if (left < 0 || right < 0) continue;
      result.splice(Math.max(left, right), 1);
      result.splice(Math.min(left, right), 1, { modifierOptionId: optionId, portion: "whole", amount });
    }
  }
  return result;
}

export function formatPizzaTopping(name: string, portion: PizzaToppingPortion, amount: PizzaToppingAmount, style: "display" | "ticket" = "display"): string {
  const pieces = [portion === "whole" ? "" : portion === "left_half" ? "Left Half" : "Right Half", amount === "extra" ? "Extra" : "", name].filter(Boolean);
  const value = pieces.join(" ");
  return style === "ticket" ? value.toUpperCase() : value;
}

"use client";

import { useState } from "react";
import type { OrderingModifierGroupView, OrderingModifierOptionView } from "@/lib/ordering-menu";
import type { OrderingItemVariantView } from "@/lib/ordering-menu-variants";
import { normalizePizzaToppings, type PizzaToppingAmount, type PizzaToppingPortion, type PizzaToppingSelection } from "@/lib/ordering-pizza-toppings";

const portions: Array<[PizzaToppingPortion, string]> = [["whole", "WHOLE"], ["left_half", "LEFT HALF"], ["right_half", "RIGHT HALF"]];
const amounts: PizzaToppingAmount[] = ["regular", "extra", "double_extra", "triple_extra"];
const labels = ["REGULAR", "EXTRA", "2× EXTRA", "3× EXTRA"];

export default function PizzaToppingSelector({ group, variant, selections, onChange }: {
  group: OrderingModifierGroupView;
  variant: OrderingItemVariantView | null;
  selections: PizzaToppingSelection[];
  onChange: (value: PizzaToppingSelection[]) => void;
}) {
  const [active, setActive] = useState<PizzaToppingPortion>("whole");
  const available = (option: OrderingModifierOptionView) => {
    const price = variant?.modifierPrices.find((candidate) => candidate.optionId === option.id);
    return option.available && (price ? price.available : true);
  };
  function level(optionId: string) {
    const exact = selections.find((entry) => entry.modifierOptionId === optionId && entry.portion === active);
    if (exact) return amounts.indexOf(exact.amount) + 1;
    if (active !== "whole") {
      const whole = selections.find((entry) => entry.modifierOptionId === optionId && entry.portion === "whole");
      if (whole) return amounts.indexOf(whole.amount) + 1;
    }
    return 0;
  }
  function change(optionId: string, delta: number) {
    let next = selections.map((entry) => ({ ...entry }));
    const current = level(optionId);
    if (active !== "whole") {
      const whole = next.find((entry) => entry.modifierOptionId === optionId && entry.portion === "whole");
      if (whole) {
        next = next.filter((entry) => entry !== whole);
        next.push(
          { modifierOptionId: optionId, portion: "left_half", amount: whole.amount },
          { modifierOptionId: optionId, portion: "right_half", amount: whole.amount },
        );
      }
    } else {
      next = next.filter((entry) => entry.modifierOptionId !== optionId);
    }
    const value = Math.max(0, Math.min(amounts.length, current + delta));
    next = next.filter((entry) => !(entry.modifierOptionId === optionId && entry.portion === active));
    if (value) next.push({ modifierOptionId: optionId, portion: active, amount: amounts[value - 1] });
    onChange(normalizePizzaToppings(next));
  }
  return <fieldset id={`modifier-${group.id}`}>
    <legend>{group.name}<small>Choose a portion, then adjust topping intensity</small></legend>
    <div className="posToppingApply"><strong>APPLY TOPPINGS TO</strong><div className="posSegmented">
      {portions.map(([value, label]) => <button type="button" className={active === value ? "selected" : ""} onClick={() => setActive(value)} key={value}>{label}</button>)}
    </div></div>
    <div className="posToppingGrid">{group.options.filter(available).map((option) => {
      const value = level(option.id);
      return <div key={option.id}>
        <button type="button" aria-label={`Decrease ${option.name}`} disabled={!value} onClick={() => change(option.id, -1)}>−</button>
        <strong>{option.name}</strong><span>{value ? labels[value - 1] : "—"}</span>
        <button type="button" aria-label={`Increase ${option.name}`} disabled={value >= amounts.length} onClick={() => change(option.id, 1)}>+</button>
      </div>;
    })}</div>
  </fieldset>;
}

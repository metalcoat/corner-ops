"use client";

import { useState } from "react";
import type { OrderingModifierGroupView, OrderingModifierOptionView } from "@/lib/ordering-menu";
import type { OrderingItemVariantView } from "@/lib/ordering-menu-variants";
import { normalizePizzaToppings, type PizzaToppingAmount, type PizzaToppingPortion, type PizzaToppingSelection } from "@/lib/ordering-pizza-toppings";

const portions: Array<[PizzaToppingPortion, string]> = [["left_half", "LEFT"], ["whole", "WHOLE"], ["right_half", "RIGHT"]];
const amounts: PizzaToppingAmount[] = ["regular", "extra", "double_extra", "triple_extra"];
const amountLabels = ["REGULAR", "EXTRA", "2× EXTRA", "3× EXTRA"];

export default function PizzaToppingSelector({ group, variant, selections, onChange }: { group: OrderingModifierGroupView; variant: OrderingItemVariantView | null; selections: PizzaToppingSelection[]; onChange: (value: PizzaToppingSelection[]) => void }) {
  const [editingPortion, setEditingPortion] = useState<Record<string, PizzaToppingPortion>>({});
  const available = (option: OrderingModifierOptionView) => option.available && (variant?.modifierPrices.find((candidate) => candidate.optionId === option.id)?.available ?? true);
  const entries = (optionId: string) => selections.filter((entry) => entry.modifierOptionId === optionId);
  function amount(optionId: string, portion: PizzaToppingPortion): PizzaToppingAmount | null {
    return entries(optionId).find((entry) => entry.portion === portion)?.amount || (portion !== "whole" ? entries(optionId).find((entry) => entry.portion === "whole")?.amount : null) || null;
  }
  function choosePortion(optionId: string, portion: PizzaToppingPortion) {
    setEditingPortion((current) => ({ ...current, [optionId]: portion }));
    let next = selections.filter((entry) => entry.modifierOptionId !== optionId).map((entry) => ({ ...entry }));
    const current = entries(optionId);
    if (portion === "whole") {
      const value = current[0]?.amount || "regular";
      if (!(current.length === 1 && current[0].portion === "whole")) next.push({ modifierOptionId: optionId, portion: "whole", amount: value });
    } else {
      const whole = current.find((entry) => entry.portion === "whole");
      const same = current.find((entry) => entry.portion === portion);
      const oppositePortion = portion === "left_half" ? "right_half" : "left_half";
      const opposite = current.find((entry) => entry.portion === oppositePortion);
      if (whole) {
        next.push({ modifierOptionId: optionId, portion, amount: whole.amount }, { modifierOptionId: optionId, portion: oppositePortion, amount: whole.amount });
      } else {
        if (!same) next.push({ modifierOptionId: optionId, portion, amount: "regular" });
        if (opposite) next.push({ ...opposite });
      }
    }
    onChange(normalizePizzaToppings(next));
  }
  function adjust(optionId: string, delta: number) {
    const current = entries(optionId);
    if (!current.length) return onChange(normalizePizzaToppings([...selections, { modifierOptionId: optionId, portion: "whole", amount: "regular" }]));
    const active = editingPortion[optionId] || current[0].portion;
    const target = current.find((entry) => entry.portion === active) || current[0];
    const index = amounts.indexOf(target.amount);
    const nextIndex = Math.max(-1, Math.min(amounts.length - 1, index + delta));
    onChange(normalizePizzaToppings(selections.flatMap((entry) => entry.modifierOptionId !== optionId || entry.portion !== target.portion ? [entry] : nextIndex < 0 ? [] : [{ ...entry, amount: amounts[nextIndex] }])));
  }
  const selectedOptions = group.options.filter((option) => entries(option.id).length);
  return <fieldset id={`modifier-${group.id}`} className="pizzaToppingBuilder">
    <legend>{group.name}<small>Every topping shows its own portion and intensity</small></legend>
    <div className="pizzaToppingRows">{group.options.filter(available).map((option) => { const selected = entries(option.id), currentAmount = selected[0]?.amount; return <div className={selected.length ? "pizzaToppingRow selected" : "pizzaToppingRow"} key={option.id}>
      <strong>{option.name}</strong><div className="portionChips">{portions.map(([portion,label])=><button type="button" key={portion} className={`${selected.some((entry) => entry.portion === portion) || (portion !== "whole" && selected.some((entry) => entry.portion === "whole")) ? "selected" : ""}${editingPortion[option.id]===portion?" editing":""}`} onClick={()=>choosePortion(option.id,portion)}>{label}</button>)}</div>
      <div className="toppingIntensity"><button type="button" aria-label={`Decrease ${option.name}`} disabled={!selected.length} onClick={()=>adjust(option.id,-1)}>−</button><span>{currentAmount ? amountLabels[amounts.indexOf(entries(option.id).find(entry=>entry.portion===(editingPortion[option.id]||entry.portion))?.amount||currentAmount)] : "ADD"}</span><button type="button" aria-label={`Increase ${option.name}`} disabled={currentAmount === "triple_extra"} onClick={()=>adjust(option.id,1)}>+</button></div>
    </div>})}</div>
    <div className="pizzaLiveSummary" aria-label="Live pizza topping summary">{(["whole","left_half","right_half"] as PizzaToppingPortion[]).map((portion)=><section key={portion}><strong>{portion.replace("_half","").toUpperCase()}</strong>{selectedOptions.flatMap((option)=>{const value=amount(option.id,portion);const explicitlyWhole=entries(option.id).some(entry=>entry.portion==="whole");if(!value || (portion==="whole"&&!explicitlyWhole))return[];return <span key={option.id}>{value==="regular"?"":`${amountLabels[amounts.indexOf(value)]} `}{option.name}</span>})}</section>)}</div>
  </fieldset>;
}

"use client";

import type { OrderingModifierGroupView, OrderingModifierOptionView } from "@/lib/ordering-menu";
import type { OrderingItemVariantView } from "@/lib/ordering-menu-variants";
import { formatPizzaTopping, type PizzaToppingAmount, type PizzaToppingPortion, type PizzaToppingSelection } from "@/lib/ordering-pizza-toppings";

const portions: Array<[PizzaToppingPortion, string]> = [["whole", "WHOLE"], ["left_half", "LEFT HALF"], ["right_half", "RIGHT HALF"]];
const amounts: Array<[PizzaToppingAmount, string]> = [["regular", "REGULAR"], ["extra", "EXTRA"]];

export default function PizzaToppingSelector({ group, variant, selections, onChange }: {
  group: OrderingModifierGroupView;
  variant: OrderingItemVariantView | null;
  selections: PizzaToppingSelection[];
  onChange: (value: PizzaToppingSelection[]) => void;
}) {
  const available = (option: OrderingModifierOptionView) => {
    const override = variant?.modifierPrices.find((price) => price.optionId === option.id);
    return option.available && (override ? override.available : true);
  };
  const setEntry = (index: number, patch: Partial<PizzaToppingSelection>) => onChange(selections.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  return <fieldset id={`modifier-${group.id}`} className="posToppingFieldset">
    <legend>{group.name}<small>Choose toppings, then portion and amount</small></legend>
    <div className="posChoiceGrid">{group.options.filter(available).map((option) => {
      const entries = selections.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.modifierOptionId === option.id);
      return <div className="posModifierChoice posToppingChoice" key={option.id}>
        <button type="button" className={entries.length ? "selected" : ""} onClick={() => onChange(entries.length ? selections.filter((entry) => entry.modifierOptionId !== option.id) : [...selections, { modifierOptionId: option.id, portion: "whole", amount: "regular" }])}>
          <strong>{option.name}</strong><span>{entries.length ? entries.map(({ entry }) => formatPizzaTopping(option.name, entry.portion, entry.amount).replace(option.name, "").trim() || "Whole · Regular").join(" / ") : "Select topping"}</span>
        </button>
        {entries.map(({ entry, index }) => <div className="posToppingControls" key={`${entry.portion}-${index}`}>
          <span>Portion</span><div className="posSegmented">{portions.map(([value, label]) => <button type="button" className={entry.portion === value ? "selected" : ""} key={value} onClick={() => setEntry(index, { portion: value })}>{label}</button>)}</div>
          <span>Amount</span><div className="posSegmented">{amounts.map(([value, label]) => <button type="button" className={entry.amount === value ? "selected" : ""} key={value} onClick={() => setEntry(index, { amount: value })}>{label}</button>)}</div>
          {entry.portion !== "whole" && entries.length === 1 && <button type="button" onClick={() => onChange([...selections, { modifierOptionId: option.id, portion: entry.portion === "left_half" ? "right_half" : "left_half", amount: entry.amount === "regular" ? "extra" : "regular" }])}>ADD OTHER HALF</button>}
          {entries.length > 1 && <button type="button" onClick={() => onChange(selections.filter((_, itemIndex) => itemIndex !== index))}>REMOVE THIS HALF</button>}
        </div>)}
      </div>;
    })}</div>
  </fieldset>;
}

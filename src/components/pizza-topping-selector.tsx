"use client";

import { useState } from "react";
import type { OrderingModifierGroupView, OrderingModifierOptionView } from "@/lib/ordering-menu";
import type { OrderingItemVariantView } from "@/lib/ordering-menu-variants";
import { normalizePizzaToppings, type PizzaToppingAmount, type PizzaToppingPortion, type PizzaToppingSelection } from "@/lib/ordering-pizza-toppings";

const amounts: PizzaToppingAmount[] = ["regular", "extra", "double_extra", "triple_extra"];
const amountLabels: Record<PizzaToppingAmount,string> = {regular:"Regular",extra:"Extra",double_extra:"2x Extra",triple_extra:"3x Extra"};
const portionLabels: Record<PizzaToppingPortion,string> = {whole:"Whole",left_half:"Left Half",right_half:"Right Half"};

export default function PizzaToppingSelector({ group, variant, selections, onChange }: { group: OrderingModifierGroupView; variant: OrderingItemVariantView | null; selections: PizzaToppingSelection[]; onChange: (value: PizzaToppingSelection[]) => void }) {
  const [editingId,setEditingId]=useState<string|null>(null);
  const [editingPortion,setEditingPortion]=useState<PizzaToppingPortion>("whole");
  const available=(option:OrderingModifierOptionView)=>option.available&&(variant?.modifierPrices.find(candidate=>candidate.optionId===option.id)?.available??true);
  const entries=(optionId:string)=>selections.filter(entry=>entry.modifierOptionId===optionId);
  function add(optionId:string){if(entries(optionId).length){setEditingId(optionId);setEditingPortion(entries(optionId)[0].portion);return}onChange(normalizePizzaToppings([...selections,{modifierOptionId:optionId,portion:"whole",amount:"regular"}]))}
  function choosePortion(optionId:string,portion:PizzaToppingPortion){const current=entries(optionId),other=selections.filter(entry=>entry.modifierOptionId!==optionId);setEditingPortion(portion);if(portion==="whole"){onChange(normalizePizzaToppings([...other,{modifierOptionId:optionId,portion:"whole",amount:current[0]?.amount||"regular"}]));return}const whole=current.find(entry=>entry.portion==="whole"),same=current.find(entry=>entry.portion===portion),oppositePortion=portion==="left_half"?"right_half":"left_half",opposite=current.find(entry=>entry.portion===oppositePortion);onChange([...other,{modifierOptionId:optionId,portion,amount:same?.amount||whole?.amount||"regular"},{modifierOptionId:optionId,portion:oppositePortion,amount:opposite?.amount||whole?.amount||"regular"}])}
  function setAmount(optionId:string,amount:PizzaToppingAmount){const current=entries(optionId),target=current.find(entry=>entry.portion===editingPortion)||current[0];if(!target)return;onChange(normalizePizzaToppings(selections.map(entry=>entry===target?{...entry,amount}:entry)))}
  function adjust(optionId:string,delta:number){const current=entries(optionId);if(!current.length)return;const target=current.find(entry=>entry.portion===editingPortion)||current[0],index=amounts.indexOf(target.amount),next=index+delta;if(next<0){const remaining=selections.filter(entry=>entry.modifierOptionId!==optionId||entry!==target);onChange(normalizePizzaToppings(remaining));if(!remaining.some(entry=>entry.modifierOptionId===optionId))setEditingId(null);return}if(next<amounts.length)setAmount(optionId,amounts[next])}
  const selectedOptions=group.options.filter(option=>entries(option.id).length);
  return <fieldset id={`modifier-${group.id}`} className="pizzaToppingBuilder">
    <legend>{group.name}<small>Tap once for Whole · Regular. Edit only when a half or extra amount is needed.</small></legend>
    <div className="pizzaToppingPalette" aria-label="Toppings">{group.options.filter(available).map(option=><button type="button" key={option.id} className={entries(option.id).length?"selected":""} onClick={()=>add(option.id)}><strong>{option.name}</strong>{entries(option.id).length&&<span>Added</span>}</button>)}</div>
    <section className="pizzaSelectedToppings" aria-label="Selected toppings"><h3>Selected toppings</h3>{!selectedOptions.length&&<p>No toppings selected.</p>}{selectedOptions.map(option=>{const current=entries(option.id),split=current.length>1;return <article key={option.id} className={editingId===option.id?"editing":""}>
      <button type="button" className="pizzaSelectedSummary" onClick={()=>{setEditingId(editingId===option.id?null:option.id);setEditingPortion(current[0].portion)}}><strong>{option.name}</strong><span>{split?current.map(entry=>`${portionLabels[entry.portion]} ${amountLabels[entry.amount]}`).join(" · "):`${portionLabels[current[0].portion]} · ${amountLabels[current[0].amount]}`}</span></button>
      <div className="pizzaQuickAdjust"><button type="button" aria-label={`Decrease or remove ${option.name}`} onClick={()=>adjust(option.id,-1)}>−</button><button type="button" aria-label={`Increase ${option.name}`} disabled={(current.find(entry=>entry.portion===editingPortion)||current[0]).amount==="triple_extra"} onClick={()=>adjust(option.id,1)}>+</button></div>
      {editingId===option.id&&<div className="pizzaInlineEditor"><strong>PORTION</strong><div>{(["left_half","whole","right_half"] as PizzaToppingPortion[]).map(portion=><button type="button" key={portion} className={editingPortion===portion?"selected":""} onClick={()=>choosePortion(option.id,portion)}>{portionLabels[portion].toUpperCase()}</button>)}</div><strong>AMOUNT</strong><div>{amounts.map(amount=><button type="button" key={amount} className={(current.find(entry=>entry.portion===editingPortion)||current[0]).amount===amount?"selected":""} onClick={()=>setAmount(option.id,amount)}>{amountLabels[amount].toUpperCase()}</button>)}</div></div>}
    </article>})}</section>
    <div className="pizzaLiveSummary" aria-label="Live pizza topping summary">{(["whole","left_half","right_half"] as PizzaToppingPortion[]).map(portion=><section key={portion}><strong>{portionLabels[portion].toUpperCase()}</strong>{selectedOptions.flatMap(option=>entries(option.id).filter(entry=>entry.portion===portion).map(entry=><span key={`${option.id}-${portion}`}>{entry.amount==="regular"?"":`${amountLabels[entry.amount]} `}{option.name}</span>))}</section>)}</div>
  </fieldset>;
}

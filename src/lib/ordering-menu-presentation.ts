import type{OrderingMenuItemWithVariants}from"@/lib/ordering-menu-variants";
export function itemNeedsConfiguration(item:OrderingMenuItemWithVariants){return item.variants.filter(v=>v.available).length>1||item.modifiers.some(g=>g.presentationContext!=="hidden"&&g.options.some(o=>o.available))||item.combos.length>0}
export function modifierPriceLabel(cents:number,defaultSelected=false){return cents?`${cents>0?"+":""}$${(cents/100).toFixed(2)}`:defaultSelected?"FREE · Default":"FREE"}

import { calculatePromotions, type Promotion, type PromotionLine } from "../src/lib/ordering-promotions";

const line:PromotionLine={id:"line",item_id:"pizza",variant_id:"jumbo",category_id:"pizza-category",quantity:1,unit_price_cents:2000,modifier_total_cents:0};
const promotion:Promotion={id:"thursday",name:"Thursday Jumbo",customer_label:"Thursday Jumbo",promotion_type:"amount_off",priority:100,rule:{components:[{id:"jumbo",quantity:1,variantIds:["jumbo"]}]},adjustment:{amountOffCents:300},active:true,automatic:true,stackable:false,stackable_with_loyalty:false,exclusive_group:"base",version:1};
const reserved=new Map([[line.id,1]]),stackable=new Map([[line.id,1]]),when=new Date("2026-08-13T16:00:00Z");
if(calculatePromotions([promotion],[line],when,"pickup","pos",reserved,stackable).length)throw new Error("Exclusive loyalty quantity was double-discounted.");
const explicitlyStackable={...promotion,stackable_with_loyalty:true};
if(calculatePromotions([explicitlyStackable],[line],when,"pickup","pos",reserved,stackable)[0]?.discountCents!==300)throw new Error("Explicit promotion/loyalty stacking was not honored.");
if(calculatePromotions([explicitlyStackable],[line],when,"pickup","pos",reserved,new Map()).length)throw new Error("One-sided stacking configuration was incorrectly honored.");
console.log(JSON.stringify({defaultExclusive:true,explicitMutualStacking:true,oneSidedStackingBlocked:true},null,2));

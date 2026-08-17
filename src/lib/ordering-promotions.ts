import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";
import { orderingLocalDateTime } from "@/lib/ordering-timing-core";
import { ensureOrderingLoyaltySchema } from "@/lib/ordering-loyalty-schema";

export type PromotionComponent = { id: string; quantity: number; itemIds?: string[]; categoryIds?: string[]; variantIds?: string[] };
export type PromotionRule = { components: PromotionComponent[]; repeatable?: boolean; daysOfWeek?: number[]; startDate?: string | null; endDate?: string | null; startTime?: string | null; endTime?: string | null; serviceTypes?: string[]; channels?: string[]; includedDates?: string[]; excludedDates?: string[] };
export type PromotionAdjustment = { bundlePriceCents?: number; amountOffCents?: number; percentBasisPoints?: number; modifierAllowances?: Array<{ groupId: string; quantity: number; intensity?: string }> };
export type Promotion = { id:string; name:string; customer_label:string; promotion_type:string; priority:number; rule:PromotionRule; adjustment:PromotionAdjustment; active:boolean; automatic:boolean; stackable:boolean; stackable_with_loyalty:boolean; exclusive_group:string; version:number };
export type PromotionLine = { id:string; item_id:string; variant_id:string|null; category_id:string; quantity:number; unit_price_cents:number; modifier_total_cents:number; modifiers?:Array<{groupId:string;optionId:string;priceCents:number;quantity:number;intensity:string}> };
type Allocation = { lineId:string; quantity:number; baseCents:number; discountCents:number };
export type AppliedPromotion = { promotionId:string; label:string; normalBaseSubtotalCents:number; discountCents:number; resultingBaseSubtotalCents:number; allocations:Allocation[] };

export function promotionScheduleMatches(rule: PromotionRule, fulfillmentAt: Date, serviceType:string, channel:string) {
  const local=orderingLocalDateTime(fulfillmentAt);
  if (rule.includedDates?.length && !rule.includedDates.includes(local.date)) return false;
  if (rule.excludedDates?.includes(local.date)) return false;
  if (rule.startDate && local.date < rule.startDate) return false;
  if (rule.endDate && local.date > rule.endDate) return false;
  if (rule.daysOfWeek?.length && !rule.daysOfWeek.includes(local.weekday)) return false;
  if (rule.startTime && local.time < rule.startTime) return false;
  if (rule.endTime && local.time > rule.endTime) return false;
  if (rule.serviceTypes?.length && !rule.serviceTypes.includes(serviceType)) return false;
  if (rule.channels?.length && !rule.channels.includes(channel)) return false;
  return true;
}
function eligible(line:PromotionLine, component:PromotionComponent){return Boolean(component.itemIds?.includes(line.item_id)||component.categoryIds?.includes(line.category_id)||(line.variant_id&&component.variantIds?.includes(line.variant_id)))}
function allocate(discount:number, selected:Map<string,{line:PromotionLine;quantity:number}>):Allocation[]{
  const rows=[...selected.values()].map(({line,quantity})=>({lineId:line.id,quantity,baseCents:line.unit_price_cents*quantity,discountCents:0})).sort((a,b)=>a.lineId.localeCompare(b.lineId));
  const base=rows.reduce((sum,row)=>sum+row.baseCents,0);let assigned=0;
  if(!discount||!base)return rows;
  rows.forEach((row,index)=>{row.discountCents=index===rows.length-1?discount-assigned:Math.floor(discount*row.baseCents/base);assigned+=row.discountCents});
  return rows;
}
export function calculatePromotions(promotions:Promotion[],lines:PromotionLine[],fulfillmentAt:Date,serviceType:string,channel:string,loyaltyReserved=new Map<string,number>(),loyaltyStackable=new Map<string,number>()):AppliedPromotion[]{
  const used=new Map<string,number>(),locked=new Map<string,number>(),exclusiveUsed=new Map<string,Map<string,number>>(),results:AppliedPromotion[]=[];
  for(const promotion of promotions.filter(p=>p.active&&p.automatic).sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id))){
    if(!promotionScheduleMatches(promotion.rule,fulfillmentAt,serviceType,channel))continue;
    let applications=0;const promotionUsed=new Map<string,number>();
    while(true){
      const selected=new Map<string,{line:PromotionLine;quantity:number}>();let complete=true;
      for(const component of promotion.rule.components||[]){let needed=Math.max(1,Math.trunc(component.quantity||1));for(const line of lines.filter(row=>eligible(row,component)).sort((a,b)=>a.id.localeCompare(b.id))){const loyaltyUnavailable=(loyaltyReserved.get(line.id)||0)-(promotion.stackable_with_loyalty?(loyaltyStackable.get(line.id)||0):0),unavailable=Math.max((promotion.stackable?locked.get(line.id):used.get(line.id))||0,promotion.exclusive_group?(exclusiveUsed.get(promotion.exclusive_group)?.get(line.id)||0):0,loyaltyUnavailable);const available=line.quantity-unavailable-(promotionUsed.get(line.id)||0)-(selected.get(line.id)?.quantity||0);const take=Math.min(needed,Math.max(0,available));if(take){const current=selected.get(line.id);selected.set(line.id,{line,quantity:(current?.quantity||0)+take});needed-=take}if(!needed)break}if(needed){complete=false;break}}
      if(!complete||!selected.size)break;
      const normal=[...selected.values()].reduce((sum,row)=>sum+row.line.unit_price_cents*row.quantity,0);
      let baseDiscount=0;
      if(promotion.promotion_type==="bundle"||promotion.promotion_type==="fixed_price")baseDiscount=Math.max(0,normal-Math.max(0,Number(promotion.adjustment.bundlePriceCents||0)));
      else if(promotion.promotion_type==="amount_off")baseDiscount=Math.min(normal,Math.max(0,Number(promotion.adjustment.amountOffCents||0))*[...selected.values()].reduce((sum,row)=>sum+row.quantity,0));
      else if(promotion.promotion_type==="percent_off")baseDiscount=Math.min(normal,Math.round(normal*Math.max(0,Number(promotion.adjustment.percentBasisPoints||0))/10000));
      const allowanceByLine=new Map<string,number>();for(const allowance of promotion.adjustment.modifierAllowances||[]){let remaining=Math.max(0,Math.trunc(allowance.quantity||0));const choices=[...selected.values()].flatMap(entry=>(entry.line.modifiers||[]).filter(modifier=>modifier.groupId===allowance.groupId&&(allowance.intensity==="any"||modifier.intensity===(allowance.intensity||"regular"))).map(modifier=>({lineId:entry.line.id,modifier}))).sort((a,b)=>a.lineId.localeCompare(b.lineId)||a.modifier.optionId.localeCompare(b.modifier.optionId));for(const choice of choices){const take=Math.min(remaining,choice.modifier.quantity);if(take){allowanceByLine.set(choice.lineId,(allowanceByLine.get(choice.lineId)||0)+take*choice.modifier.priceCents);remaining-=take}if(!remaining)break}}
      const allowanceDiscount=[...allowanceByLine.values()].reduce((sum,value)=>sum+value,0),discount=baseDiscount+allowanceDiscount;
      if(!discount)break;
      const allocations=allocate(baseDiscount,selected);for(const allocation of allocations)allocation.discountCents+=allowanceByLine.get(allocation.lineId)||0;results.push({promotionId:promotion.id,label:promotion.customer_label||promotion.name,normalBaseSubtotalCents:normal,discountCents:discount,resultingBaseSubtotalCents:normal-baseDiscount,allocations});
      for(const row of allocations)promotionUsed.set(row.lineId,(promotionUsed.get(row.lineId)||0)+row.quantity);
      applications+=1;if(!promotion.rule.repeatable||applications>999)break;
    }
    for(const [lineId,quantity] of promotionUsed){used.set(lineId,(used.get(lineId)||0)+quantity);if(!promotion.stackable)locked.set(lineId,(locked.get(lineId)||0)+quantity);if(promotion.exclusive_group){const group=exclusiveUsed.get(promotion.exclusive_group)||new Map<string,number>();group.set(lineId,(group.get(lineId)||0)+quantity);exclusiveUsed.set(promotion.exclusive_group,group)}}
  }
  return results;
}
export async function applyPromotionsToOrder(orderId:string){
  await ensureOrderingPromotionSchema();await ensureOrderingLoyaltySchema();const sql=getSql();
  const orders=await sql`SELECT id,business,source,service_type,status,COALESCE(scheduled_for,created_at) fulfillment_at,subtotal_cents,discount_cents,promotion_discount_cents,tax_cents,tip_cents,delivery_fee_cents,paid_cents FROM ordering_orders WHERE id=${orderId}`;const order=orders[0];if(!order||order.status!=="draft")return [];
  const promotions=await sql`SELECT id,name,customer_label,promotion_type,priority,rule,adjustment,active,automatic,stackable,stackable_with_loyalty,exclusive_group,version FROM ordering_promotions WHERE business=${order.business} AND active=TRUE AND automatic=TRUE ORDER BY priority DESC,id` as Promotion[];
  const lines=await sql`SELECT line.id,line.item_id,line.variant_id,item.category_id,line.quantity,line.unit_price_cents,line.modifier_total_cents FROM ordering_order_items line JOIN ordering_menu_items item ON item.id=line.item_id WHERE line.order_id=${orderId} ORDER BY line.sort_order,line.id` as PromotionLine[];
  const modifiers=await sql`SELECT modifier.order_item_id,modifier.group_id,modifier.option_id,modifier.unit_price_delta_cents,modifier.quantity,modifier.pizza_topping_amount,modifier.amount FROM ordering_order_item_modifiers modifier JOIN ordering_order_items line ON line.id=modifier.order_item_id WHERE line.order_id=${orderId} AND modifier.selection_state IN('selected','extra')`;
  for(const line of lines)line.modifiers=modifiers.filter(row=>String(row.order_item_id)===line.id).map(row=>({groupId:String(row.group_id),optionId:String(row.option_id),priceCents:Number(row.unit_price_delta_cents),quantity:Number(row.quantity),intensity:String(row.pizza_topping_amount||row.amount||"regular").replace("normal","regular")}));
  const loyaltyRows=await sql`SELECT order_item_id,consumed_quantity,configuration_snapshot FROM ordering_order_loyalty_applications WHERE order_id=${orderId}`;const loyaltyReserved=new Map<string,number>(),loyaltyStackable=new Map<string,number>();for(const row of loyaltyRows){const lineId=String(row.order_item_id),quantity=Number(row.consumed_quantity);loyaltyReserved.set(lineId,(loyaltyReserved.get(lineId)||0)+quantity);if(row.configuration_snapshot?.stackable)loyaltyStackable.set(lineId,(loyaltyStackable.get(lineId)||0)+quantity)}
  const applied=calculatePromotions(promotions,lines,new Date(order.fulfillment_at),String(order.service_type),String(order.source),loyaltyReserved,loyaltyStackable);
  await sql`DELETE FROM ordering_order_promotion_applications WHERE order_id=${orderId}`;
  for(let index=0;index<applied.length;index++){const result=applied[index],promotion=promotions.find(row=>row.id===result.promotionId)!;const applicationId=randomUUID();await sql`INSERT INTO ordering_order_promotion_applications(id,order_id,promotion_id,promotion_version,label_snapshot,configuration_snapshot,normal_base_subtotal_cents,discount_cents,resulting_base_subtotal_cents,application_sequence) VALUES(${applicationId},${orderId},${promotion.id},${promotion.version},${result.label},${JSON.stringify({rule:promotion.rule,adjustment:promotion.adjustment,priority:promotion.priority,stackable:promotion.stackable,stackableWithLoyalty:promotion.stackable_with_loyalty,exclusiveGroup:promotion.exclusive_group})}::jsonb,${result.normalBaseSubtotalCents},${result.discountCents},${result.resultingBaseSubtotalCents},${index})`;for(const allocation of result.allocations)await sql`INSERT INTO ordering_order_promotion_allocations(id,application_id,order_item_id,consumed_quantity,normal_base_cents,discount_cents) VALUES(${randomUUID()},${applicationId},${allocation.lineId},${allocation.quantity},${allocation.baseCents},${allocation.discountCents})`}
  const loyaltyDiscount=Number((await sql`SELECT loyalty_discount_cents FROM ordering_orders WHERE id=${orderId}`)[0]?.loyalty_discount_cents||0),promotionDiscount=applied.reduce((sum,row)=>sum+row.discountCents,0),discount=loyaltyDiscount+promotionDiscount,grossBase=lines.reduce((sum,row)=>sum+Number(row.unit_price_cents)*Number(row.quantity),0),modifierRevenue=lines.reduce((sum,row)=>sum+Number(row.modifier_total_cents)*Number(row.quantity),0);await sql`UPDATE ordering_orders SET discount_cents=${discount},gross_base_merchandise_cents=${grossBase},modifier_revenue_cents=${modifierRevenue},promotion_discount_cents=${promotionDiscount},net_merchandise_cents=GREATEST(0,subtotal_cents-${discount}),total_cents=GREATEST(0,subtotal_cents-${discount}+tax_cents+tip_cents+delivery_fee_cents),amount_due_cents=GREATEST(0,subtotal_cents-${discount}+tax_cents+tip_cents+delivery_fee_cents-paid_cents),updated_at=NOW() WHERE id=${orderId}`;
  return applied;
}

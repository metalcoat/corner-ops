import { randomUUID } from "node:crypto";
import { loyaltyBaseDiscount, loyaltyUpgrades } from "@/lib/ordering-loyalty-cap";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingLoyaltySchema } from "@/lib/ordering-loyalty-schema";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { applyPromotionsToOrder } from "@/lib/ordering-promotions";
import { loyaltyEarnPaymentEligible, loyaltyLineEligible as eligible } from "@/lib/ordering-loyalty-earn";

type Eligibility={itemIds?:string[];categoryIds?:string[];variantIds?:string[];quantityRequired?:number;channels?:string[];serviceTypes?:string[];discountedItemsQualify?:boolean};
type Reward={itemIds?:string[];categoryIds?:string[];variantIds?:string[];quantity?:number;modifierAllowances?:Array<{groupId:string;quantity:number;intensity?:string}>;expirationDays?:number|null;capVariantId?:string|null};
type Program={id:string;name:string;customer_name:string;description:string;qualifying_rule:Eligibility;reward_rule:Reward;active:boolean;version:number;priority:number;stackable:boolean};

async function rewardCap(rule:Reward){if(!rule.capVariantId)return null;const rows=await getSql()`SELECT base_price_cents FROM ordering_menu_item_variants WHERE id=${rule.capVariantId}`;return rows[0]?Number(rows[0].base_price_cents):null}
async function rewardUpgrades(rule:Reward){const cap=await rewardCap(rule);if(cap==null||!rule.variantIds?.length)return [];const variants=await getSql()`SELECT id,name,base_price_cents FROM ordering_menu_item_variants WHERE id=ANY(${rule.variantIds}::uuid[]) AND active=TRUE ORDER BY sort_order,name`;return loyaltyUpgrades(cap,rule.capVariantId,variants.map(row=>({id:String(row.id),name:String(row.name),priceCents:Number(row.base_price_cents)})))}
export async function loyaltyStatus(customerId:string,business="Corner Deli"){
  await ensureOrderingLoyaltySchema();const sql=getSql();
  const programs=await sql`SELECT id,name,customer_name,description,qualifying_rule,reward_rule,active,version,priority,stackable FROM ordering_loyalty_programs WHERE business=${business} AND active=TRUE ORDER BY name` as Program[];
  const result=[];for(const program of programs){const rows=await sql`SELECT COALESCE(SUM(delta_units),0) units FROM ordering_loyalty_ledger WHERE customer_id=${customerId} AND program_id=${program.id}`;const units=Number(rows[0].units),required=Math.max(1,Number(program.qualifying_rule.quantityRequired||10));result.push({programId:program.id,name:program.customer_name||program.name,units,quantityRequired:required,progress:((units%required)+required)%required,rewardsAvailable:Math.max(0,Math.floor(units/required)),upgrades:await rewardUpgrades(program.reward_rule)})}return result;
}
export async function loyaltyHistory(customerId:string,limit=12){await ensureOrderingLoyaltySchema();return getSql()`SELECT ledger.id,ledger.entry_type,ledger.delta_units,ledger.reason,ledger.created_by,ledger.created_at,orders.display_number,program.customer_name,program.name FROM ordering_loyalty_ledger ledger JOIN ordering_loyalty_programs program ON program.id=ledger.program_id LEFT JOIN ordering_orders orders ON orders.id=ledger.order_id WHERE ledger.customer_id=${customerId} ORDER BY ledger.created_at DESC,ledger.id LIMIT ${Math.max(1,Math.min(100,limit))}`}

export async function requestLoyaltyRedemption(input:{orderId:string;orderItemId:string;programId:string;actor:OrderingActor}){
  await ensureOrderingLoyaltySchema();return withTransaction(async()=>{const sql=getSql();const orders=await sql`SELECT id,business,customer_id,status,source,service_type FROM ordering_orders WHERE id=${input.orderId} FOR UPDATE`;const order=orders[0];if(!order||order.status!=="draft")throw new Error("Loyalty rewards can only be requested on a draft order.");if(!order.customer_id)throw new Error("Attach a customer before redeeming loyalty.");
  await sql`SELECT id FROM ordering_customers WHERE id=${order.customer_id} FOR UPDATE`;
  const existing=await sql`SELECT id FROM ordering_order_loyalty_applications WHERE order_id=${input.orderId} AND program_id=${input.programId} AND order_item_id=${input.orderItemId}`;
  if(existing.length)return recalculateLoyaltyOrder(input.orderId);
  const programs=await sql`SELECT id,name,customer_name,description,qualifying_rule,reward_rule,active,version,priority,stackable FROM ordering_loyalty_programs WHERE id=${input.programId} AND business=${order.business} AND active=TRUE` as Program[];const program=programs[0];if(!program)throw new Error("Loyalty program is unavailable.");const status=(await loyaltyStatus(String(order.customer_id),String(order.business))).find(row=>row.programId===program.id);const pending=await sql`SELECT configuration_snapshot FROM ordering_order_loyalty_applications WHERE order_id=${input.orderId} AND program_id=${program.id} AND redemption_event_id IS NULL`;
  const reservedUnits=pending.reduce((sum,row)=>sum+Math.max(1,Number(row.configuration_snapshot?.qualifyingRule?.quantityRequired||10)),0);
  if(!status||status.units-reservedUnits<Math.max(1,Number(program.qualifying_rule.quantityRequired||10)))throw new Error("No loyalty reward is available.");
  const items=await sql`SELECT line.id,line.item_id,line.variant_id,item.category_id,line.quantity,line.cancelled_quantity,line.unit_price_cents,line.modifier_total_cents FROM ordering_order_items line JOIN ordering_menu_items item ON item.id=line.item_id WHERE line.id=${input.orderItemId} AND line.order_id=${input.orderId}`;const item=items[0];if(!item||!eligible(item,program.reward_rule))throw new Error("The selected item is not eligible for this reward.");
  const quantity=Math.max(1,Math.trunc(Number(program.reward_rule.quantity||1)));
  const reserved=await sql`SELECT COALESCE(SUM(consumed_quantity),0) quantity FROM ordering_order_loyalty_applications WHERE order_item_id=${input.orderItemId}`;
  if(Number(item.quantity)-Number(item.cancelled_quantity||0)-Number(reserved[0].quantity)<quantity)throw new Error("The selected quantity already has a loyalty reward or was cancelled.");
  if((await sql`SELECT 1 FROM ordering_order_points_redemptions WHERE order_item_id=${input.orderItemId}`)[0])throw new Error("Remove the points reward on this item before applying a pizza reward.");
  const modifiers=await sql`SELECT group_id,option_id,unit_price_delta_cents,quantity,pizza_topping_amount,amount FROM ordering_order_item_modifiers WHERE order_item_id=${input.orderItemId} AND selection_state IN('selected','extra') ORDER BY created_at,id`;let modifierDiscount=0;for(const allowance of program.reward_rule.modifierAllowances||[]){let remaining=Math.max(0,allowance.quantity);const choices=modifiers.filter(row=>String(row.group_id)===allowance.groupId).sort((left,right)=>Number(Boolean(left.pizza_topping_amount&&left.pizza_topping_amount!=="regular"))-Number(Boolean(right.pizza_topping_amount&&right.pizza_topping_amount!=="regular"))||String(left.option_id).localeCompare(String(right.option_id)));for(const modifier of choices){const pizzaAmount=String(modifier.pizza_topping_amount||""),intensity=pizzaAmount||String(modifier.amount||"normal").replace("normal","regular");if(allowance.intensity!=="any"&&intensity!=="regular"&&!pizzaAmount)continue;const multiplier=pizzaAmount==="triple_extra"?4:pizzaAmount==="double_extra"?3:pizzaAmount==="extra"?2:1,includedUnit=allowance.intensity==="regular"?Math.floor(Number(modifier.unit_price_delta_cents)/multiplier):Number(modifier.unit_price_delta_cents),take=Math.min(remaining,Number(modifier.quantity));modifierDiscount+=take*includedUnit;remaining-=take;if(!remaining)break}}
  modifierDiscount=Math.min(Math.max(0,Number(item.modifier_total_cents)),Math.max(0,modifierDiscount))*quantity;const baseDiscount=loyaltyBaseDiscount(Number(item.unit_price_cents),await rewardCap(program.reward_rule))*quantity;await sql`INSERT INTO ordering_order_loyalty_applications(id,order_id,order_item_id,customer_id,program_id,program_version,label_snapshot,configuration_snapshot,consumed_quantity,base_discount_cents,modifier_discount_cents,discount_cents,requested_by) VALUES(${randomUUID()},${input.orderId},${input.orderItemId},${order.customer_id},${program.id},${program.version},${program.customer_name||program.name},${JSON.stringify({qualifyingRule:program.qualifying_rule,rewardRule:program.reward_rule,priority:program.priority,stackable:program.stackable})}::jsonb,${quantity},${baseDiscount},${modifierDiscount},${baseDiscount+modifierDiscount},${input.actor.id}) ON CONFLICT(order_id,program_id,order_item_id) DO NOTHING`;
  await recalculateLoyaltyOrder(input.orderId);await applyPromotionsToOrder(input.orderId);return recalculateLoyaltyOrder(input.orderId);});
}

export async function recalculateLoyaltyOrder(orderId:string){await ensureOrderingLoyaltySchema();const sql=getSql();const rows=await sql`SELECT COALESCE((SELECT SUM(discount_cents) FROM ordering_order_loyalty_applications WHERE order_id=${orderId}),0)+COALESCE((SELECT SUM(discount_cents) FROM ordering_order_points_redemptions WHERE order_id=${orderId}),0) loyalty`;const loyalty=Number(rows[0].loyalty);await sql`UPDATE ordering_orders SET loyalty_discount_cents=${loyalty},discount_cents=promotion_discount_cents+${loyalty},net_merchandise_cents=GREATEST(0,subtotal_cents-promotion_discount_cents-${loyalty}),total_cents=GREATEST(0,subtotal_cents-promotion_discount_cents-${loyalty}+tax_cents+tip_cents+delivery_fee_cents),amount_due_cents=GREATEST(0,subtotal_cents-promotion_discount_cents-${loyalty}+tax_cents+tip_cents+delivery_fee_cents-paid_cents),updated_at=NOW() WHERE id=${orderId}`;return sql`SELECT label,discount_cents,order_item_id FROM (SELECT label_snapshot label,discount_cents,order_item_id,applied_at,id FROM ordering_order_loyalty_applications WHERE order_id=${orderId} UNION ALL SELECT label_snapshot||' ('||points||' pts)',discount_cents,order_item_id,applied_at,id FROM ordering_order_points_redemptions WHERE order_id=${orderId}) applied ORDER BY applied_at,id`}

export async function finalizeLoyaltyRedemptions(orderId:string){
  await ensureOrderingLoyaltySchema();
  return withTransaction(async()=>{
    const sql=getSql();
    const [order]=await sql`SELECT id,business,customer_id,status FROM ordering_orders WHERE id=${orderId} FOR UPDATE`;
    if(!order)return;
    const applications=await sql`SELECT app.*,program.qualifying_rule FROM ordering_order_loyalty_applications app JOIN ordering_loyalty_programs program ON program.id=app.program_id WHERE app.order_id=${orderId} AND app.redemption_event_id IS NULL ORDER BY app.id FOR UPDATE OF app`;
    if(!applications.length)return;
    if(!["sent_to_kitchen","in_progress","ready","completed"].includes(String(order.status)))throw new Error("Submit this order before finalizing loyalty rewards.");
    await sql`SELECT id FROM ordering_customers WHERE id=${order.customer_id} FOR UPDATE`;
    for(const app of applications){
      if(String(app.customer_id)!==String(order.customer_id))throw new Error("The loyalty reward belongs to a different customer.");
      const required=Math.max(1,Number(app.configuration_snapshot?.qualifyingRule?.quantityRequired||app.qualifying_rule.quantityRequired||10));
      const [balance]=await sql`SELECT COALESCE(SUM(delta_units),0) units FROM ordering_loyalty_ledger WHERE customer_id=${app.customer_id} AND program_id=${app.program_id} AND business=${order.business}`;
      if(Number(balance.units)<required)throw new Error("The requested loyalty reward is no longer available.");
      const eventId=randomUUID();
      await sql`INSERT INTO ordering_loyalty_ledger(id,business,program_id,customer_id,order_id,order_item_id,entry_type,delta_units,description,created_by,metadata) VALUES(${eventId},${order.business},${app.program_id},${app.customer_id},${orderId},${app.order_item_id},'redeem',${-required},${app.label_snapshot},${app.requested_by},${JSON.stringify({applicationId:app.id,discountCents:Number(app.discount_cents)})}::jsonb)`;
      await sql`UPDATE ordering_order_loyalty_applications SET redemption_event_id=${eventId} WHERE id=${app.id}`;
    }
  });
}

export async function earnLoyaltyForOrder(orderId:string,actor:OrderingActor){
  await ensureOrderingLoyaltySchema();
  return withTransaction(async()=>{
    const sql=getSql();
    const [order]=await sql`SELECT id,business,customer_id,source,service_type,status,payment_status,paid_cents,total_cents,amount_due_cents FROM ordering_orders WHERE id=${orderId} FOR UPDATE`;
    if(!order?.customer_id||!["draft","sent_to_kitchen","in_progress","ready","completed"].includes(String(order.status)))return;
    await sql`SELECT id FROM ordering_customers WHERE id=${order.customer_id} FOR UPDATE`;
    const programs=await sql`SELECT id,name,qualifying_rule FROM ordering_loyalty_programs WHERE business=${order.business} AND (active=TRUE OR EXISTS(SELECT 1 FROM ordering_loyalty_ledger earned WHERE earned.program_id=ordering_loyalty_programs.id AND earned.order_id=${orderId} AND earned.entry_type='earn'))`;
    let items=await sql`SELECT line.id,line.item_id,line.variant_id,item.category_id,line.quantity-COALESCE(line.cancelled_quantity,0) quantity FROM ordering_order_items line JOIN ordering_menu_items item ON item.id=line.item_id WHERE line.order_id=${orderId}`;
    if(order.status==="draft"){
      const [reopen]=await sql`SELECT details FROM ordering_order_events WHERE order_id=${orderId} AND event_type='order_reopened_for_additions' ORDER BY created_at DESC LIMIT 1`;
      const sentIds=new Set((reopen?.details?.existingItemIds||[]).map(String));
      if(!sentIds.size)return;
      items=items.filter(item=>sentIds.has(String(item.id)));
    }
    const promoted=new Set((await sql`SELECT allocation.order_item_id FROM ordering_order_promotion_allocations allocation JOIN ordering_order_promotion_applications application ON application.id=allocation.application_id WHERE application.order_id=${orderId} AND allocation.discount_cents>0`).map(row=>String(row.order_item_id)));
    const rewarded=await sql`SELECT order_item_id,SUM(consumed_quantity) quantity FROM ordering_order_loyalty_applications WHERE order_id=${orderId} GROUP BY order_item_id`;
    const rewardedUnits=new Map(rewarded.map(row=>[String(row.order_item_id),Number(row.quantity)]));
    const pointsLines=new Set((await sql`SELECT order_item_id FROM ordering_order_points_redemptions WHERE order_id=${orderId}`).map(row=>String(row.order_item_id)));
    for(const program of programs){
      const events=await sql`SELECT entry_type,delta_units,metadata FROM ordering_loyalty_ledger WHERE program_id=${program.id} AND order_id=${orderId} AND (entry_type='earn' OR (entry_type='adjustment' AND metadata->>'kind'='order_earn_adjustment')) ORDER BY created_at,id`;
      const original=events.find(row=>row.entry_type==='earn');
      if(order.status==="draft"&&!original)continue;
      const rule=(original?.metadata?.qualifyingRule||program.qualifying_rule) as Eligibility;
      if(rule.channels?.length&&!rule.channels.includes(String(order.source)))continue;
      if(rule.serviceTypes?.length&&!rule.serviceTypes.includes(String(order.service_type)))continue;
      const units=items.filter(item=>eligible(item,rule)&&(rule.discountedItemsQualify!==false||(!promoted.has(String(item.id))&&!pointsLines.has(String(item.id))))).reduce((sum,item)=>sum+Math.max(0,Number(item.quantity)-(rule.discountedItemsQualify===false?(rewardedUnits.get(String(item.id))||0):0)),0);
      const earned=events.reduce((sum,row)=>sum+Number(row.delta_units),0),delta=units-earned;
      if(!delta||(delta>0&&(order.status==="draft"||!loyaltyEarnPaymentEligible({payment_status:order.payment_status,paid_cents:order.paid_cents,total_cents:order.total_cents,amount_due_cents:order.amount_due_cents}))))continue;
      const grossEarned=events.filter(row=>row.entry_type==='earn').reduce((sum,row)=>sum+Number(row.delta_units),0);
      const metadata={quantity:delta,earnedThroughUnits:grossEarned+Math.max(0,delta),qualifyingRule:rule,...(delta<0?{kind:"order_earn_adjustment"}: {})};
      await sql`INSERT INTO ordering_loyalty_ledger(id,business,program_id,customer_id,order_id,entry_type,delta_units,description,created_by,metadata) VALUES(${randomUUID()},${order.business},${program.id},${order.customer_id},${orderId},${delta<0?'adjustment':'earn'},${delta},${program.name},${actor.id},${JSON.stringify(metadata)}::jsonb) ON CONFLICT DO NOTHING`;
    }
  });
}

/** A fully refunded payment cannot retain earned punches. Reward use is unchanged. */
export async function clawbackUnpaidLoyaltyEarnings(orderId:string,actor:OrderingActor,reason:string){
  await ensureOrderingLoyaltySchema();
  return withTransaction(async()=>{
    const sql=getSql();
    const [order]=await sql`SELECT business,customer_id,paid_cents FROM ordering_orders WHERE id=${orderId} FOR UPDATE`;
    if(!order?.customer_id||Number(order.paid_cents)>0)return;
    await sql`SELECT id FROM ordering_customers WHERE id=${order.customer_id} FOR UPDATE`;
    const totals=await sql`SELECT program_id,SUM(delta_units) units FROM ordering_loyalty_ledger earned WHERE order_id=${orderId} AND customer_id=${order.customer_id} AND (entry_type='earn' OR (entry_type='adjustment' AND metadata->>'kind'='order_earn_adjustment')) AND NOT EXISTS(SELECT 1 FROM ordering_loyalty_ledger reversed WHERE reversed.related_event_id=earned.id AND reversed.entry_type='void_reversal') GROUP BY program_id`;
    for(const total of totals){
      const units=Number(total.units);
      if(units<=0)continue;
      await sql`INSERT INTO ordering_loyalty_ledger(id,business,program_id,customer_id,order_id,entry_type,delta_units,reason,description,created_by,metadata) VALUES(${randomUUID()},${order.business},${total.program_id},${order.customer_id},${orderId},'adjustment',${-units},${reason},'Fully refunded order punches removed',${actor.id},'{"kind":"order_earn_adjustment","cause":"full_payment_refund"}'::jsonb)`;
    }
  });
}

export async function reverseLoyaltyForOrder(orderId:string,actor:OrderingActor,reason:string){await ensureOrderingLoyaltySchema();const sql=getSql();const events=await sql`SELECT * FROM ordering_loyalty_ledger WHERE order_id=${orderId} AND (entry_type IN('earn','redeem') OR (entry_type='adjustment' AND metadata->>'kind'='order_earn_adjustment'))`;for(const event of events){const type=event.entry_type!=="redeem"?"void_reversal":"redemption_reversal";await sql`INSERT INTO ordering_loyalty_ledger(id,business,program_id,customer_id,order_id,order_item_id,entry_type,delta_units,related_event_id,reason,description,created_by,metadata) VALUES(${randomUUID()},${event.business},${event.program_id},${event.customer_id},${orderId},${event.order_item_id},${type},${-Number(event.delta_units)},${event.id},${reason},${event.description},${actor.id},${JSON.stringify({reversedEventType:event.entry_type})}::jsonb) ON CONFLICT DO NOTHING`}}

export async function adjustLoyalty(input:{customerId:string;programId:string;deltaUnits:number;reason:string;actor:OrderingActor}){if(!canManagePos(input.actor))throw new Error("Manager or owner authorization is required.");if(!Number.isSafeInteger(input.deltaUnits)||!input.deltaUnits)throw new Error("Adjustment must be a non-zero whole unit amount.");if(input.reason.trim().length<3)throw new Error("An adjustment reason is required.");await ensureOrderingLoyaltySchema();const sql=getSql();const owned=await sql`SELECT program.id,program.business FROM ordering_loyalty_programs program JOIN ordering_customers customer ON customer.id=${input.customerId} AND customer.business=program.business WHERE program.id=${input.programId} AND customer.active=TRUE`;if(!owned[0])throw new Error("Customer or loyalty program was not found.");await sql`INSERT INTO ordering_loyalty_ledger(id,business,program_id,customer_id,entry_type,delta_units,reason,description,created_by,metadata) VALUES(${randomUUID()},${owned[0].business},${input.programId},${input.customerId},'manager_adjustment',${input.deltaUnits},${input.reason.trim()},'Manager adjustment',${input.actor.id},${JSON.stringify({actorName:input.actor.name,actorRole:input.actor.role})}::jsonb)`;return loyaltyStatus(input.customerId,String(owned[0].business))}

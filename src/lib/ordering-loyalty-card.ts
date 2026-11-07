import { getSql } from "@/lib/db";
import { loyaltyEarnPaymentEligible, loyaltyLineEligible } from "@/lib/ordering-loyalty-earn";
import { pointsBalanceSnapshot, pointsOrderEligibleCents, pointsRewards, pointsSettings } from "@/lib/ordering-points";
import { pointsEarnRate } from "@/lib/ordering-points-rules";
import { toIsoTimestampOrEmpty } from "@/lib/timestamp-values";

export type LoyaltyCardEvent = {
  id: string; type: string; amount: number; description: string; reason: string;
  createdAt: string; orderId: string | null; orderNumber: string | null; programName: string | null;
};
export type OrderLoyaltyCard = {
  order: { id:string; displayNumber:string; status:string; paymentStatus:string; paidCents:number; totalCents:number; amountDueCents:number };
  customer: { id:string; name:string; active:boolean } | null;
  points: { active:boolean; balance:number; expired:boolean; rewards:Array<{id:string;label:string;points:number;kind:string}> };
  programs:Array<{id:string;name:string;units:number;quantityRequired:number;progress:number;rewardsAvailable:number}>;
  thisOrder: {points:LoyaltyCardEvent[];loyalty:LoyaltyCardEvent[]};
  history: {points:LoyaltyCardEvent[];loyalty:LoyaltyCardEvent[]};
  notes:Array<{code:string;message:string}>;
};

function event(row:Record<string,unknown>):LoyaltyCardEvent {
  return {id:String(row.id),type:String(row.entry_type),amount:Number(row.amount),description:String(row.description||""),reason:String(row.reason||""),createdAt:toIsoTimestampOrEmpty(row.created_at),orderId:row.order_id?String(row.order_id):null,orderNumber:row.display_number?String(row.display_number):null,programName:row.program_name?String(row.program_name):null};
}

/** Staff read-only view. The order supplies the account and business, never a caller's customer ID. */
export async function orderLoyaltyCard(orderId:string):Promise<OrderLoyaltyCard|null> {
  const sql=getSql();
  const [order]=await sql`SELECT o.id,o.display_number,o.status,o.payment_status,o.paid_cents,o.total_cents,o.amount_due_cents,o.customer_id,o.source,o.service_type,o.order_origin,o.caller_phone,c.id linked_customer_id,c.first_name,c.last_name,c.display_name,c.active customer_active FROM ordering_orders o LEFT JOIN ordering_customers c ON c.id=o.customer_id AND c.business=o.business WHERE o.id=${orderId} AND o.business='Corner Deli'`;
  if(!order)return null;
  const result:OrderLoyaltyCard={
    order:{id:String(order.id),displayNumber:String(order.display_number),status:String(order.status),paymentStatus:String(order.payment_status),paidCents:Number(order.paid_cents),totalCents:Number(order.total_cents),amountDueCents:Number(order.amount_due_cents)},
    customer:null,points:{active:false,balance:0,expired:false,rewards:[]},programs:[],thisOrder:{points:[],loyalty:[]},history:{points:[],loyalty:[]},notes:[],
  };
  if(!order.linked_customer_id){
    result.notes.push({code:"no_customer",message:"No customer account is linked to this order."});
    return result;
  }
  const customerId=String(order.linked_customer_id);
  result.customer={id:customerId,name:String(order.display_name||`${order.first_name||""} ${order.last_name||""}`.trim()||"Customer"),active:Boolean(order.customer_active)};
  const settings=await pointsSettings();
  const [balance,rewards,programs,currentPoints,currentLoyalty,recentPoints,recentLoyalty,eligibleCents,lines,phones]=await Promise.all([
    pointsBalanceSnapshot(customerId,"Corner Deli",settings),pointsRewards(),
    sql`SELECT p.id,p.name,p.customer_name,p.qualifying_rule,COALESCE((SELECT SUM(delta_units) FROM ordering_loyalty_ledger l WHERE l.program_id=p.id AND l.customer_id=${customerId} AND l.business='Corner Deli'),0) units FROM ordering_loyalty_programs p WHERE p.business='Corner Deli' AND p.active=TRUE ORDER BY p.priority DESC,p.name`,
    sql`SELECT l.id,l.entry_type,l.points amount,l.description,l.reason,l.created_at,l.order_id,o.display_number FROM ordering_points_ledger l LEFT JOIN ordering_orders o ON o.id=l.order_id AND o.business=l.business WHERE l.business='Corner Deli' AND l.customer_id=${customerId} AND l.order_id=${orderId} ORDER BY l.created_at DESC,l.id`,
    sql`SELECT l.id,l.entry_type,l.delta_units amount,l.description,l.reason,l.created_at,l.order_id,o.display_number,COALESCE(NULLIF(p.customer_name,''),p.name) program_name FROM ordering_loyalty_ledger l JOIN ordering_loyalty_programs p ON p.id=l.program_id AND p.business=l.business LEFT JOIN ordering_orders o ON o.id=l.order_id AND o.business=l.business WHERE l.business='Corner Deli' AND l.customer_id=${customerId} AND l.order_id=${orderId} ORDER BY l.created_at DESC,l.id`,
    sql`SELECT l.id,l.entry_type,l.points amount,l.description,l.reason,l.created_at,l.order_id,o.display_number FROM ordering_points_ledger l LEFT JOIN ordering_orders o ON o.id=l.order_id AND o.business=l.business WHERE l.business='Corner Deli' AND l.customer_id=${customerId} ORDER BY l.created_at DESC,l.id LIMIT 20`,
    sql`SELECT l.id,l.entry_type,l.delta_units amount,l.description,l.reason,l.created_at,l.order_id,o.display_number,COALESCE(NULLIF(p.customer_name,''),p.name) program_name FROM ordering_loyalty_ledger l JOIN ordering_loyalty_programs p ON p.id=l.program_id AND p.business=l.business LEFT JOIN ordering_orders o ON o.id=l.order_id AND o.business=l.business WHERE l.business='Corner Deli' AND l.customer_id=${customerId} ORDER BY l.created_at DESC,l.id LIMIT 20`,
    pointsOrderEligibleCents(orderId),
    sql`SELECT line.id,line.item_id,line.variant_id,item.category_id,line.quantity-COALESCE(line.cancelled_quantity,0) quantity,COALESCE((SELECT SUM(consumed_quantity) FROM ordering_order_loyalty_applications a WHERE a.order_item_id=line.id),0) rewarded_quantity,EXISTS(SELECT 1 FROM ordering_order_promotion_allocations a WHERE a.order_item_id=line.id AND a.discount_cents>0) promoted,EXISTS(SELECT 1 FROM ordering_order_points_redemptions r WHERE r.order_item_id=line.id) points_rewarded FROM ordering_order_items line JOIN ordering_menu_items item ON item.id=line.item_id WHERE line.order_id=${orderId}`,
    sql`SELECT normalized_phone FROM ordering_customer_phones WHERE customer_id=${customerId}`,
  ]);
  result.points={active:settings.active,balance:balance.balance,expired:balance.expired,rewards:rewards.map(row=>({id:String(row.id),label:String(row.label),points:Number(row.points),kind:String(row.kind)}))};
  result.programs=programs.map(row=>{const units=Number(row.units),quantityRequired=Math.max(1,Number(row.qualifying_rule?.quantityRequired||10));return{id:String(row.id),name:String(row.customer_name||row.name),units,quantityRequired,progress:Math.max(0,units)%quantityRequired,rewardsAvailable:Math.max(0,Math.floor(units/quantityRequired))}});
  result.thisOrder={points:currentPoints.map(event),loyalty:currentLoyalty.map(event)};
  result.history={points:recentPoints.map(event),loyalty:recentLoyalty.map(event)};
  if(!result.customer.active)result.notes.push({code:"inactive_customer",message:"This customer account is inactive."});
  if(balance.expired)result.notes.push({code:"points_expired",message:`The available points balance is zero after ${settings.expiryMonths} months without a qualifying purchase.`});
  if(order.status==="cancelled")result.notes.push({code:"cancelled",message:"This order is cancelled and cannot earn new rewards."});
  else if(order.payment_status==="refunded"&&Number(order.paid_cents)===0)result.notes.push({code:"refunded",message:"This order has no payment remaining after its refund. Recorded reward adjustments and reversals are listed below."});
  else if(order.status==="draft")result.notes.push({code:"draft",message:"New items earn rewards after the order is sent and fully paid."});
  else if(!loyaltyEarnPaymentEligible({payment_status:order.payment_status,paid_cents:order.paid_cents,total_cents:order.total_cents,amount_due_cents:order.amount_due_cents}))result.notes.push({code:"not_fully_paid",message:order.payment_status==="partially_refunded"?"This order was partly refunded. Item cancellations adjust earned credit; a full refund removes the remaining earned credit.":"This order is not fully paid. Eligible purchases earn rewards after the final payment."});
  if(!settings.active)result.notes.push({code:"points_paused",message:"The points program is currently turned off."});
  else if(eligibleCents===0)result.notes.push({code:"no_points_items",message:"The current items have no value eligible for points. Discounted items and items covered by the Jumbo punch card do not earn points."});
  else if(!pointsEarnRate({source:String(order.source),orderOrigin:String(order.order_origin||""),paymentStatus:String(order.payment_status),callerPhone:String(order.caller_phone||""),customerPhones:phones.map(row=>String(row.normalized_phone))},settings))result.notes.push({code:"points_channel",message:"This order does not currently qualify for points under the program's ordering-channel settings."});
  const qualifying=programs.some(program=>{const rule=program.qualifying_rule||{};return(!rule.channels?.length||rule.channels.includes(order.source))&&(!rule.serviceTypes?.length||rule.serviceTypes.includes(order.service_type))&&lines.some(line=>loyaltyLineEligible(line,rule)&&Number(line.quantity)>0&&(rule.discountedItemsQualify!==false||(!line.promoted&&!line.points_rewarded&&Number(line.quantity)>Number(line.rewarded_quantity))))});
  if(!qualifying)result.notes.push({code:"no_punch_items",message:"The current items do not qualify for punches under the active pizza-program rules."});
  if(!currentPoints.some(row=>row.entry_type==="earn")&&!currentLoyalty.some(row=>row.entry_type==="earn"))result.notes.push({code:"no_earning_recorded",message:"No earned points or punches are recorded for this order."});
  return result;
}

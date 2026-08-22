import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import { createTimedDraftOrder } from "@/lib/ordering-timed-orders";
import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
import { applyScheduledMenuAvailability } from "@/lib/ordering-menu-availability";
import { resolveOrderingAvailability, listFutureOrderingSlots } from "@/lib/ordering-availability";
import { getDeliveryPricingSettings, quoteDelivery } from "@/lib/ordering-delivery";
import { findCustomers } from "@/lib/ordering-customers";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";
import { submitDraftOrder, OrderConflictError } from "@/lib/ordering-order-lifecycle";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";

export type AiToolErrorCode = "INVALID_INPUT"|"NOT_FOUND"|"VERSION_CONFLICT"|"VALIDATION_REQUIRED"|"NOT_AUTHORIZED"|"NOT_AVAILABLE"|"SEND_BLOCKED"|"INTERNAL_ERROR";
export class AiToolError extends Error {
  constructor(public code: AiToolErrorCode, message: string, public remedy: string, public status = 409, public details: Record<string, unknown> = {}) { super(message); }
}

export type AiItemInput = VariantConfiguredOrderItemInput;
export type SpokenOrderItem={name:string;variant?:string;quantity?:number;modifiers?:Array<{name:string;portion?:"whole"|"left_half"|"right_half";amount?:"regular"|"extra"|"double_extra"|"triple_extra"}>};
const services: ServiceType[] = ["undecided","pickup","delivery","no_contact_delivery","dine_in","curbside","bar"];
export function serviceType(value: unknown): ServiceType {
  if (services.includes(value as ServiceType)) return value as ServiceType;
  throw new AiToolError("INVALID_INPUT", "The service type is not supported.", "Use one of the serviceTypes returned by describe_capabilities.", 400);
}
export function requestedDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new AiToolError("INVALID_INPUT", "The scheduled fulfillment time is invalid.", "Choose an ISO timestamp returned by future_slots.", 400);
  return date;
}
export function itemInputs(value: unknown): AiItemInput[] {
  if (!Array.isArray(value) || value.length > 50) throw new AiToolError("INVALID_INPUT", "Items must be an array of at most 50 entries.", "Use stable menu IDs from menu_search or menu_browse.", 400);
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new AiToolError("INVALID_INPUT", "An order item is invalid.", "Send structured item IDs and selections from the menu response.", 400);
    const row = raw as Record<string, unknown>;
    return { itemId:String(row.itemId||""), variantId:row.variantId?String(row.variantId):null, quantity:Math.trunc(Number(row.quantity||1)), modifierSelections:objectOfStringArrays(row.modifierSelections), modifierQuantities:objectOfNumbers(row.modifierQuantities), modifierAmounts:(row.modifierAmounts&&typeof row.modifierAmounts==="object"?row.modifierAmounts:{} ) as Record<string,"light"|"normal"|"heavy">, modifierDeclines:Array.isArray(row.modifierDeclines)?row.modifierDeclines.map(String):[], pizzaToppings:Array.isArray(row.pizzaToppings)?row.pizzaToppings as AiItemInput["pizzaToppings"]:[], comboId:row.comboId?String(row.comboId):null, comboSelections:objectOfStringArrays(row.comboSelections), specialInstructions:String(row.specialInstructions||"").slice(0,500) };
  });
}
function objectOfStringArrays(value: unknown) { if (!value || typeof value!=="object") return {}; return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,Array.isArray(v)?v.map(String):[]])); }
function objectOfNumbers(value: unknown) { if (!value || typeof value!=="object") return {}; return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,Number(v)])); }

export async function menuCatalog(business: OrderingBusiness, at: Date, query = "") {
  const categories = await applyScheduledMenuAvailability(business, at, await orderingMenuWithVariants(business,"pos") as unknown as Array<Record<string,any>>);
  const q=query.trim().toLocaleLowerCase(),tokens=q.match(/[a-z0-9]+/g)||[];
  if(!q)return categories.map((category:any)=>({id:category.id,name:category.displayName,items:category.items.map((item:any)=>({id:item.id,name:item.name,description:item.description||"",available:Boolean(item.available),basePriceCents:Number(item.basePriceCents),variants:item.variants,modifiers:item.modifiers,combos:item.combos}))}));
  const ranked=categories.flatMap((category:any)=>category.items.map((item:any)=>{
    const name=String(item.name||"").toLocaleLowerCase(),haystack=JSON.stringify(item).toLocaleLowerCase();
    if(tokens.length&&!tokens.every(token=>haystack.includes(token)))return null;
    const score=(name===q?1000:q.includes(name)?500:0)+Math.max(0,100-name.length);
    return{categoryId:category.id,categoryName:category.displayName,score,item};
  }).filter(Boolean)).sort((a:any,b:any)=>b.score-a.score).slice(0,5);
  const grouped=new Map<string,{id:string;name:string;items:any[]}>();
  for(const match of ranked as any[]){const category:{id:string;name:string;items:any[]}=grouped.get(match.categoryId)||{id:match.categoryId,name:match.categoryName,items:[]};category.items.push({id:match.item.id,name:match.item.name,description:match.item.description||"",available:Boolean(match.item.available),basePriceCents:Number(match.item.basePriceCents),variants:match.item.variants,modifiers:match.item.modifiers,combos:match.item.combos});grouped.set(match.categoryId,category)}
  return[...grouped.values()];
}

export async function availabilityBundle(business: OrderingBusiness, service: ServiceType, at = new Date()) {
  const [availability, delivery] = await Promise.all([resolveOrderingAvailability({business,serviceType:service,at}), getDeliveryPricingSettings(business)]);
  return { serverTime:new Date().toISOString(), availability, deliveryPolicy:{enabled:delivery.enabled,minimumOrderCents:delivery.minimumOrderCents,maxDistanceMiles:delivery.maxDistanceMiles,feeBands:delivery.feeBands} };
}

export async function futureSlots(business: OrderingBusiness, service: ServiceType, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AiToolError("INVALID_INPUT","A valid business date is required.","Use YYYY-MM-DD.",400);
  return (await listFutureOrderingSlots({business,serviceType:service,businessDate:date})).map(value=>value.toISOString());
}

async function pricedOrder(orderId: string, business: OrderingBusiness) {
  const sql=getSql(); const rows=await sql`SELECT id,business,display_number,status,payment_status,service_type,timing_mode,scheduled_for,version,customer_id,first_name_snapshot,last_name_snapshot,phone_snapshot,subtotal_cents,discount_cents,tax_cents,tip_cents,delivery_fee_cents,total_cents,paid_cents,amount_due_cents,timing_message_snapshot FROM ordering_orders WHERE id=${orderId} AND business=${business}`;
  if(!rows[0]) throw new AiToolError("NOT_FOUND","The order was not found.","Use the order ID returned by create_draft.",404);
  const lines=await sql`SELECT id,item_id,item_name_snapshot,variant_id,variant_name_snapshot,quantity,unit_price_cents,modifier_total_cents,combo_total_cents,line_total_cents,special_instructions FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
  const promotions=await sql`SELECT promotion_id,label_snapshot,discount_cents FROM ordering_order_promotion_applications WHERE order_id=${orderId} ORDER BY application_sequence`;
  return { ...(rows[0] as Record<string, unknown>), lines, promotions, pricingAuthority:"corner_ops_server", currency:"USD" } as Record<string, any>;
}

export async function createAiDraft(input:{business:OrderingBusiness;actor:OrderingActor;service:ServiceType;items:AiItemInput[];customerId?:string|null;callerPhone?:string;firstName?:string;lastName?:string;scheduledFor?:Date|null}) {
  const timing=input.scheduledFor?"future":"asap";
  const order=await createTimedDraftOrder({business:input.business,source:"ai_phone",serviceType:input.service,customerId:input.customerId||null,callerPhone:input.callerPhone||"",customerFirstName:input.firstName||"",customerLastName:input.lastName||"",orderOrigin:"ai",createdBy:input.actor.id,createdByName:input.actor.name,items:input.items,timingMode:timing,requestedFor:input.scheduledFor||null});
  return pricedOrder(String(order.id),input.business);
}

const spokenKey=(value:string)=>value.toLocaleLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/s\b/g,"");
export async function priceSpokenOrder(input:{business:OrderingBusiness;actor:OrderingActor;service:ServiceType;items:SpokenOrderItem[];orderId?:string|null;callerPhone?:string;firstName?:string;lastName?:string}){
  const catalog=await orderingMenuWithVariants(input.business,"pos"),allItems=catalog.flatMap(category=>category.items).filter(item=>item.available);
  const resolved:AiItemInput[]=input.items.map(requested=>{
    const wanted=spokenKey(requested.name),matches=allItems.filter(item=>{const name=spokenKey(item.name);return name===wanted||name.includes(wanted)||wanted.includes(name)}).sort((a,b)=>(spokenKey(a.name)===wanted?-1000:0)+a.name.length-((spokenKey(b.name)===wanted?-1000:0)+b.name.length));
    if(!matches[0])throw new AiToolError("NOT_FOUND",`Menu item not found: ${requested.name}.`,"Use a canonical menu item name such as Pizza, Wings, or Large French Fries.",404);
    const item=matches[0],rawVariant=spokenKey(requested.variant||""),variantWanted=item.name==="Pizza"&&["large","jumbo","jumbo thin"].includes(rawVariant)?"jumbo thin":rawVariant;
    const variant=variantWanted?item.variants.find(row=>{const values=[row.name,...row.aliases].map(spokenKey);return values.some(value=>value===variantWanted||value.includes(variantWanted)||variantWanted.includes(value))}):item.variants.find(row=>row.defaultVariant)||item.variants[0];
    if(variantWanted&&!variant)throw new AiToolError("NOT_FOUND",`Menu variant not found: ${requested.variant}.`,`Use a size/form returned for ${item.name}.`,404);
    const modifierSelections:Record<string,string[]>={},pizzaToppings:NonNullable<AiItemInput["pizzaToppings"]>=[];
    for(const requestedModifier of requested.modifiers||[]){const key=spokenKey(requestedModifier.name),choices=item.modifiers.flatMap(group=>group.options.map(option=>({group,option}))).filter(({option})=>option.available&&spokenKey(option.name)===key);if(choices.length!==1)throw new AiToolError("NOT_FOUND",`Modifier not found or ambiguous: ${requestedModifier.name}.`,`Use an exact modifier name for ${item.name}.`,404);const{group,option}=choices[0];if(group.presentationBehavior==="pizza_topping")pizzaToppings.push({modifierOptionId:option.id,portion:requestedModifier.portion||"whole",amount:requestedModifier.amount||"regular"});else modifierSelections[group.id]=[...(modifierSelections[group.id]||[]),option.id]}
    return{itemId:item.id,variantId:variant?.id||null,quantity:Math.max(1,Math.trunc(Number(requested.quantity||1))),modifierSelections,pizzaToppings};
  });
  if(input.orderId){const current=(await getSql()`SELECT version FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business}`)[0];if(!current)throw new AiToolError("NOT_FOUND","The active draft was not found.","Create a new priced draft.",404);return replaceAiDraft({business:input.business,actor:input.actor,orderId:input.orderId,expectedVersion:Number(current.version),service:input.service,items:resolved,callerPhone:input.callerPhone,firstName:input.firstName,lastName:input.lastName})}
  return createAiDraft({business:input.business,actor:input.actor,service:input.service,items:resolved,callerPhone:input.callerPhone,firstName:input.firstName,lastName:input.lastName});
}

export async function replaceAiDraft(input:{business:OrderingBusiness;actor:OrderingActor;orderId:string;expectedVersion:number;service:ServiceType;items:AiItemInput[];customerId?:string|null;callerPhone?:string;firstName?:string;lastName?:string;scheduledFor?:Date|null}) {
  const current=(await getSql()`SELECT * FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business}`)[0];
  if(!current) throw new AiToolError("NOT_FOUND","The draft was not found.","Refresh the live draft and use its stable ID.",404);
  if(current.status!=="draft") throw new AiToolError("VALIDATION_REQUIRED","Only a draft order can be updated.","Create a new draft; historical sent orders are immutable.");
  if(Number(current.version)!==input.expectedVersion) throw new AiToolError("VERSION_CONFLICT","The draft changed since it was read.","Fetch the draft again, merge the customer's changes, and retry with the new version.",409,{currentVersion:Number(current.version)});
  const temporary=await createAiDraft({...input,orderId:undefined} as Parameters<typeof createAiDraft>[0]);
  try {
    await withTransaction(async()=>{ const sql=getSql(); const locked=(await sql`SELECT version,status FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`)[0];
      if(!locked||locked.status!=="draft"||Number(locked.version)!==input.expectedVersion) throw new AiToolError("VERSION_CONFLICT","The draft changed while it was being priced.","Fetch the draft and retry with its current version.",409,{currentVersion:Number(locked?.version||0)});
      await sql`DELETE FROM ordering_order_promotion_applications WHERE order_id=${input.orderId}`;
      await sql`DELETE FROM ordering_order_items WHERE order_id=${input.orderId}`;
      await sql`UPDATE ordering_order_items SET order_id=${input.orderId} WHERE order_id=${temporary.id}`;
      await sql`UPDATE ordering_order_promotion_applications SET order_id=${input.orderId} WHERE order_id=${temporary.id}`;
      await sql`UPDATE ordering_orders target SET service_type=source.service_type,timing_mode=source.timing_mode,scheduled_for=source.scheduled_for,timing_message_snapshot=source.timing_message_snapshot,customer_id=source.customer_id,customer_phone_id=source.customer_phone_id,first_name_snapshot=source.first_name_snapshot,last_name_snapshot=source.last_name_snapshot,phone_snapshot=source.phone_snapshot,subtotal_cents=source.subtotal_cents,discount_cents=source.discount_cents,tax_cents=source.tax_cents,tip_cents=source.tip_cents,delivery_fee_cents=0,total_cents=source.total_cents,amount_due_cents=source.amount_due_cents,version=target.version+1,updated_at=NOW() FROM ordering_orders source WHERE target.id=${input.orderId} AND source.id=${temporary.id}`;
      await sql`DELETE FROM ordering_orders WHERE id=${temporary.id}`;
    });
  } catch(error) { await getSql()`DELETE FROM ordering_orders WHERE id=${temporary.id}`; throw error; }
  return pricedOrder(input.orderId,input.business);
}

export async function holdDraft(orderId:string,business:OrderingBusiness) {
  const order=await pricedOrder(orderId,business); const missing:string[]=[];
  if(order.status!=="draft") throw new AiToolError("VALIDATION_REQUIRED","Only draft orders can be held.","Use the current order state.");
  if(order.service_type==="undecided") missing.push("serviceType");
  if(!(order.lines as unknown[]).length) missing.push("items");
  if(["delivery","no_contact_delivery"].includes(String(order.service_type))) { const address=(await getSql()`SELECT id,route_status,distance_miles FROM ordering_order_delivery_addresses WHERE order_id=${orderId}`)[0]; if(!address) missing.push("deliveryAddress"); else if(address.route_status!=="routed") missing.push("deliveryValidation"); }
  if(!String(order.first_name_snapshot||"").trim()) missing.push("customer.firstName");
  if(!String(order.phone_snapshot||"").trim() && ["pickup","delivery","no_contact_delivery","curbside"].includes(String(order.service_type))) missing.push("customer.phone");
  return {order,hold:{accepted:true,sendReady:missing.length===0,missingFields:missing,remedy:missing.length?"Collect the listed fields, update the same draft, then HOLD again.":"Read back the server total and obtain customer confirmation before SEND."}};
}

export async function sendDraft(orderId:string,business:OrderingBusiness,actor:OrderingActor) { try { return await submitDraftOrder(orderId,business,actor); } catch(error) { if(error instanceof OrderConflictError) throw new AiToolError("SEND_BLOCKED",error.message,"Resolve the validation issue on the draft, HOLD again, and retry SEND."); throw error; } }

export async function customerLookup(business:OrderingBusiness,query:string) { if(query.trim().length<3) throw new AiToolError("INVALID_INPUT","Customer lookup needs at least three characters or digits.","Ask for a full phone number or more of the customer's name.",400); return findCustomers(business,query); }
export async function promotions(business:OrderingBusiness) { await ensureOrderingPromotionSchema(); return getSql()`SELECT id,name,customer_label,automatic,priority,starts_at,ends_at FROM ordering_promotions WHERE business=${business} AND active=TRUE AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW()) ORDER BY priority DESC,id`; }
export async function deliveryQuote(business:OrderingBusiness,distanceMiles:number,subtotalCents:number) { if(!Number.isFinite(distanceMiles)||!Number.isInteger(subtotalCents)||subtotalCents<0) throw new AiToolError("INVALID_INPUT","Distance and merchandise subtotal are invalid.","Use routed distance and server-priced merchandise subtotal in integer cents.",400); return quoteDelivery({business,distanceMiles,merchandiseSubtotalCents:subtotalCents}); }

export async function auditAiTool(input:{business:OrderingBusiness;requestId:string;conversationId:string;tool:string;actor:OrderingActor;orderId?:string;customerId?:string;outcome:"success"|"blocked"|"error";errorCode?:string;inputSummary:Record<string,unknown>;resultSummary:Record<string,unknown>;durationMs:number;model?:string}) { await ensureOrderingAiSchema(); await getSql()`INSERT INTO ordering_ai_tool_events(id,business,request_id,conversation_id,tool_name,actor_id,order_id,customer_id,outcome,error_code,input_summary,result_summary,duration_ms,model) VALUES(${randomUUID()},${input.business},${input.requestId},${input.conversationId},${input.tool},${input.actor.id},${input.orderId||null},${input.customerId||null},${input.outcome},${input.errorCode||""},${JSON.stringify(input.inputSummary)}::jsonb,${JSON.stringify(input.resultSummary)}::jsonb,${input.durationMs},${input.model||""})`; }

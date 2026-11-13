import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { getSql } from "@/lib/db";
import { appendConfiguredOrderItemsWithVariants, type VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import { changeOrderFulfillment, DeliveryAddressNeededError, orderOpenForChanges } from "@/lib/ordering-fulfillment-change";
import { OrderConflictError } from "@/lib/ordering-order-lifecycle";
import { orderingActor } from "@/lib/ordering-route-auth";
import { parseCustomItems, type CustomItemInput } from "@/lib/custom-item-rules";
import { appendCustomOrderItems } from "@/lib/ordering-custom-items";
import { assignNewItemsToPrimaryCheck } from "@/lib/ordering-checks";

export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();
    const{id}=await params,body=await request.json() as {items?:VariantConfiguredOrderItemInput[];customItems?:unknown;serviceType?:unknown;deliveryAddress?:unknown;deliveryUnit?:unknown;deliveryValidationToken?:unknown};
    const sql=getSql();
    let order=(await sql`SELECT * FROM ordering_orders WHERE id=${id} AND business='Corner Deli'`)[0];
    if(!order||order.status!=="draft")return isoJson({error:"This order is not open for changes."},{status:409});
    if(!await orderOpenForChanges(id,order))return isoJson({error:"Use Open in POS before changing a sent order."},{status:409});
    const items=Array.isArray(body.items)?body.items:[];
    let customItems:CustomItemInput[];
    try{customItems=parseCustomItems(body.customItems)}catch(error){return isoJson({error:error instanceof Error?error.message:"Custom items are not valid."},{status:409})}
    const orderItemIds=items.length?await appendConfiguredOrderItemsWithVariants(id,"Corner Deli",items):[];
    orderItemIds.push(...await appendCustomOrderItems(id,"Corner Deli",customItems,actor));
    order=(await sql`SELECT * FROM ordering_orders WHERE id=${id}`)[0];
    const requestedService=body.serviceType==="delivery"?"delivery":body.serviceType==="pickup"?"pickup":String(order.service_type);
    if(requestedService!==order.service_type){
      try{order=await changeOrderFulfillment(id,"Corner Deli",actor,{serviceType:requestedService as "pickup"|"delivery",deliveryAddress:String(body.deliveryAddress||""),deliveryUnit:String(body.deliveryUnit||""),deliveryValidationToken:String(body.deliveryValidationToken||"")})}
      catch(error){if(error instanceof OrderConflictError||error instanceof DeliveryAddressNeededError)return isoJson({error:error.message},{status:409});throw error}
    }
    await assignNewItemsToPrimaryCheck(id,orderItemIds);
    return isoJson({order,orderItems:orderItemIds.map(itemId=>({id:itemId}))},{status:201});
  }catch(error){return apiError(error)}
}

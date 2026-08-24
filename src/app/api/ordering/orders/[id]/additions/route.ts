import { apiError, unauthorized } from "@/lib/http";
import { getSql } from "@/lib/db";
import { appendConfiguredOrderItemsWithVariants, type VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();
    const{id}=await params,body=await request.json() as {items?:VariantConfiguredOrderItemInput[]};
    const order=(await getSql()`SELECT id,status,display_number,total_cents,delivery_fee_cents,scheduled_for,timing_message_snapshot,kitchen_timing_label_snapshot FROM ordering_orders WHERE id=${id} AND business='Corner Deli'`)[0];
    if(!order||order.status!=="draft")return Response.json({error:"This order is not open for additions."},{status:409});
    const reopen=(await getSql()`SELECT 1 FROM ordering_order_events WHERE order_id=${id} AND event_type='order_reopened_for_additions' ORDER BY created_at DESC LIMIT 1`)[0];
    if(!reopen)return Response.json({error:"Use Reopen Order before adding to a sent order."},{status:409});
    const items=Array.isArray(body.items)?body.items:[];if(!items.length)return Response.json({error:"Add at least one item."},{status:409});
    const orderItemIds=await appendConfiguredOrderItemsWithVariants(id,"Corner Deli",items);
    const updated=(await getSql()`SELECT * FROM ordering_orders WHERE id=${id}`)[0];
    return Response.json({order:updated,orderItems:orderItemIds.map(itemId=>({id:itemId}))},{status:201});
  }catch(error){return apiError(error)}
}

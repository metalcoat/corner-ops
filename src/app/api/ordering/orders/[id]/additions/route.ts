import { apiError, unauthorized } from "@/lib/http";
import { addressForOrder, routeDeliveryAddress } from "@/lib/ordering-address";
import { saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";
import { getSql } from "@/lib/db";
import { quoteDelivery } from "@/lib/ordering-delivery";
import { appendConfiguredOrderItemsWithVariants, type VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import { orderingActor } from "@/lib/ordering-route-auth";
import { randomUUID } from "node:crypto";

export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();
    const{id}=await params,body=await request.json() as {items?:VariantConfiguredOrderItemInput[];serviceType?:unknown;deliveryAddress?:unknown;deliveryUnit?:unknown;deliveryValidationToken?:unknown};
    const sql=getSql();
    let order=(await sql`SELECT * FROM ordering_orders WHERE id=${id} AND business='Corner Deli'`)[0];
    if(!order||order.status!=="draft")return Response.json({error:"This order is not open for changes."},{status:409});
    const reopen=(await sql`SELECT 1 FROM ordering_order_events WHERE order_id=${id} AND event_type='order_reopened_for_additions' AND NOT EXISTS(SELECT 1 FROM ordering_order_events later WHERE later.order_id=${id} AND later.event_type='order_addition_submitted' AND later.created_at>ordering_order_events.created_at) ORDER BY created_at DESC LIMIT 1`)[0];
    if(!reopen)return Response.json({error:"Use Open in POS before changing a sent order."},{status:409});
    const items=Array.isArray(body.items)?body.items:[];
    const orderItemIds=items.length?await appendConfiguredOrderItemsWithVariants(id,"Corner Deli",items):[];
    order=(await sql`SELECT * FROM ordering_orders WHERE id=${id}`)[0];
    const requestedService=body.serviceType==="delivery"?"delivery":body.serviceType==="pickup"?"pickup":String(order.service_type);
    if(requestedService!==order.service_type){
      const previousService=String(order.service_type);let deliveryFeeCents=0,formattedAddress="";
      if(requestedService==="delivery"){
        const enteredAddress=String(body.deliveryAddress||"").trim();let validatedAddress;
        try{validatedAddress=addressForOrder("delivery",String(body.deliveryValidationToken||""),enteredAddress)}catch(error){return Response.json({error:error instanceof Error?error.message:"Validate the delivery address."},{status:409})}
        if(!validatedAddress)return Response.json({error:"Validate the delivery address."},{status:409});
        let route=null;try{route=await routeDeliveryAddress(validatedAddress)}catch{/* Routing may be temporarily unavailable. */}
        await saveOrderDeliveryAddress({orderId:id,address:validatedAddress,line2:String(body.deliveryUnit||""),customerAddressId:null,route});formattedAddress=validatedAddress.formattedAddress;
        if(route){const quote=await quoteDelivery({business:"Corner Deli",distanceMiles:route.distanceMiles,merchandiseSubtotalCents:Number(order.subtotal_cents)});deliveryFeeCents=quote.deliveryFeeCents}
      }
      const updated=(await sql`UPDATE ordering_orders SET service_type=${requestedService},delivery_fee_cents=${deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${deliveryFeeCents}-paid_cents),payment_status=CASE WHEN paid_cents<=0 THEN 'unpaid' WHEN paid_cents>=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${deliveryFeeCents}) THEN 'paid' ELSE 'partially_paid' END,version=version+1,updated_at=NOW() WHERE id=${id} RETURNING *`)[0];
      await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)VALUES(${randomUUID()},${id},${updated.version},'order_fulfillment_changed',${actor.type},${actor.id},${JSON.stringify({from:previousService,to:requestedService,deliveryFeeCents,deliveryAddress:formattedAddress,actorName:actor.name})}::jsonb)`;order=updated;
    }
    const checks=await sql`SELECT id,paid_cents,total_cents FROM ordering_checks WHERE order_id=${id} ORDER BY display_sequence,id`;
    if(checks.length){
      const primary=checks[0];
      for(const itemId of orderItemIds){const item=(await sql`SELECT quantity,line_total_cents FROM ordering_order_items WHERE id=${itemId}`)[0];if(item)await sql`INSERT INTO ordering_check_line_assignments(check_id,order_item_id,quantity,allocated_cents) VALUES(${primary.id},${itemId},${item.quantity},${item.line_total_cents}) ON CONFLICT(check_id,order_item_id) DO UPDATE SET quantity=EXCLUDED.quantity,allocated_cents=EXCLUDED.allocated_cents`}
      const otherTotal=checks.slice(1).reduce((sum,row)=>sum+Number(row.total_cents),0),primaryTotal=Math.max(0,Number(order.total_cents)-otherTotal);
      await sql`UPDATE ordering_checks SET total_cents=${primaryTotal},amount_due_cents=GREATEST(0,${primaryTotal}-paid_cents),status=CASE WHEN paid_cents=0 THEN 'open' WHEN paid_cents>=${primaryTotal} THEN 'paid' ELSE 'partially_paid' END,updated_at=NOW() WHERE id=${primary.id}`;
    }
    return Response.json({order,orderItems:orderItemIds.map(itemId=>({id:itemId}))},{status:201});
  }catch(error){return apiError(error)}
}

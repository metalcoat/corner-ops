import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { changeOrderFulfillment, DeliveryAddressNeededError } from "@/lib/ordering-fulfillment-change";
import { OrderConflictError } from "@/lib/ordering-order-lifecycle";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime="nodejs";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();
    const{id}=await params,body=await request.json() as {serviceType?:unknown;deliveryAddress?:unknown;deliveryUnit?:unknown;deliveryValidationToken?:unknown};
    if(body.serviceType!=="pickup"&&body.serviceType!=="delivery")return isoJson({error:"Choose pickup or delivery."},{status:400});
    const order=await changeOrderFulfillment(id,"Corner Deli",actor,{serviceType:body.serviceType,deliveryAddress:String(body.deliveryAddress||""),deliveryUnit:String(body.deliveryUnit||""),deliveryValidationToken:String(body.deliveryValidationToken||"")});
    return isoJson({order});
  }catch(error){
    if(error instanceof DeliveryAddressNeededError)return isoJson({error:error.message,needsAddress:true},{status:409});
    if(error instanceof OrderConflictError)return isoJson({error:error.message},{status:409});
    return apiError(error);
  }
}

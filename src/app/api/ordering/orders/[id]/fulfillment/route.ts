import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { changeOrderFulfillment, DeliveryAddressNeededError, ManagerApprovalNeededError } from "@/lib/ordering-fulfillment-change";
import { OrderConflictError } from "@/lib/ordering-order-lifecycle";
import { orderingActor } from "@/lib/ordering-route-auth";
import { managerApprovalFromPin } from "@/lib/pos-auth";
import { pinAttemptKeys } from "@/lib/pos-access-guard";

export const runtime="nodejs";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();
    const{id}=await params,body=await request.json() as {serviceType?:unknown;deliveryAddress?:unknown;deliveryUnit?:unknown;deliveryValidationToken?:unknown;managerPin?:unknown};
    if(body.serviceType!=="pickup"&&body.serviceType!=="delivery")return isoJson({error:"Choose pickup or delivery."},{status:400});
    let approver;
    if(body.managerPin){
      try{approver=await managerApprovalFromPin(body.managerPin,pinAttemptKeys(request.headers));}
      catch(error){return isoJson({error:error instanceof Error?error.message:"Manager PIN not accepted.",needsManagerPin:true},{status:403});}
    }
    const order=await changeOrderFulfillment(id,"Corner Deli",actor,{serviceType:body.serviceType,deliveryAddress:String(body.deliveryAddress||""),deliveryUnit:String(body.deliveryUnit||""),deliveryValidationToken:String(body.deliveryValidationToken||"")},approver);
    return isoJson({order});
  }catch(error){
    if(error instanceof DeliveryAddressNeededError)return isoJson({error:error.message,needsAddress:true},{status:409});
    if(error instanceof ManagerApprovalNeededError)return isoJson({error:error.message,needsManagerPin:true},{status:403});
    if(error instanceof OrderConflictError)return isoJson({error:error.message},{status:409});
    return apiError(error);
  }
}

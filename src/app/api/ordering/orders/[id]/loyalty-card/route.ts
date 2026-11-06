import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { orderLoyaltyCard } from "@/lib/ordering-loyalty-card";
import { isoJson } from "@/lib/timestamp-values";

export const runtime="nodejs";

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    if(!await orderingActor("Corner Deli"))return unauthorized();
    const {id}=await params;
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return isoJson({error:"Order not found."},{status:404});
    const card=await orderLoyaltyCard(id);
    return card?isoJson(card,{headers:{"Cache-Control":"private, no-store"}}):isoJson({error:"Order not found."},{status:404});
  }catch(error){return apiError(error)}
}

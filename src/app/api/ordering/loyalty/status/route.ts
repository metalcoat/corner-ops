import { isoJson } from "@/lib/timestamp-values";
import { orderingActor } from "@/lib/ordering-route-auth";
import { loyaltyHistory, loyaltyStatus } from "@/lib/ordering-loyalty";
export async function GET(request:Request){if(!await orderingActor("Corner Deli"))return isoJson({error:"POS authentication required."},{status:401});const customerId=new URL(request.url).searchParams.get("customerId")||"";return isoJson({programs:await loyaltyStatus(customerId),history:await loyaltyHistory(customerId)})}

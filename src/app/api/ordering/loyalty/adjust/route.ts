import { isoJson } from "@/lib/timestamp-values";
import { orderingActor } from "@/lib/ordering-route-auth";
import { adjustLoyalty } from "@/lib/ordering-loyalty";
export async function POST(request:Request){try{const actor=await orderingActor("Corner Deli");if(!actor)return isoJson({error:"POS authentication required."},{status:401});const body=await request.json() as Record<string,unknown>;return isoJson({programs:await adjustLoyalty({customerId:String(body.customerId||""),programId:String(body.programId||""),deltaUnits:Number(body.deltaUnits),reason:String(body.reason||""),actor})})}catch(error){const message=error instanceof Error?error.message:"Adjustment failed.";return isoJson({error:message},{status:message.includes("authorization")?403:400})}}

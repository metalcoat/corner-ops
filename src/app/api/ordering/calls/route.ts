import { orderingActor } from "@/lib/ordering-route-auth";
import { acknowledgeDeliCall,activeDeliCalls } from "@/lib/three-cx-live-calls";
export const runtime="nodejs";
export async function GET(){const actor=await orderingActor("Corner Deli");if(!actor)return Response.json({error:"POS authentication required."},{status:401});return Response.json({calls:await activeDeliCalls()})}
export async function PATCH(request:Request){const actor=await orderingActor("Corner Deli");if(!actor)return Response.json({error:"POS authentication required."},{status:401});const body=await request.json();return Response.json({ok:await acknowledgeDeliCall(String(body.id||""),actor.id)})}

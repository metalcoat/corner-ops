import {isAuthorizationResponse,orderingManagerActor} from "@/lib/ordering-route-auth";
import {findDeliveryRewards,redeemDeliveryReward} from "@/lib/delivery-boy/server";
export const runtime="nodejs";
export async function GET(request:Request){const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;return Response.json({rewards:await findDeliveryRewards(new URL(request.url).searchParams.get("q")||"")})}
export async function POST(request:Request){const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;try{const body=await request.json();return Response.json({reward:await redeemDeliveryReward(String(body.code||""),actor.name)})}catch(e){return Response.json({error:e instanceof Error?e.message:"Redemption failed."},{status:409})}}

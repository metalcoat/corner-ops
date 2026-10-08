import { isAuthorizationResponse, orderingManagerActor } from "@/lib/ordering-route-auth";
import { findRewards, redeemReward } from "@/lib/pizza-gauntlet/server";
export const runtime="nodejs";
export async function GET(request:Request){const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;return Response.json({rewards:await findRewards(new URL(request.url).searchParams.get("q")||"")})}
export async function POST(request:Request){const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;try{const body=await request.json() as Record<string,unknown>;return Response.json({reward:await redeemReward(String(body.code||""),actor.name,String(body.note||""))})}catch(error){return Response.json({error:error instanceof Error?error.message:"Redemption failed."},{status:409})}}

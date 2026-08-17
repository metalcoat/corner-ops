import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { mergeCustomers } from "@/lib/ordering-customers";
export const runtime="nodejs";
export async function POST(request:Request){try{const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();const b=await request.json() as Record<string,unknown>;return Response.json(await mergeCustomers({business:"Corner Deli",survivorId:String(b.survivorId||""),mergedId:String(b.mergedId||""),actorId:actor.id}))}catch(error){return apiError(error)}}

import { giftCardReport } from "@/lib/ordering-gift-cards";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { unauthorized } from "@/lib/http";
export async function GET(request:Request){const value=new URL(request.url).searchParams.get('business');if(value!=='Corner Deli'&&value!=='Tiki')return Response.json({error:'Unknown business.'},{status:400});const business=value as OrderingBusiness,actor=await orderingActor(business);if(!actor)return unauthorized();if(!canManagePos(actor))return Response.json({error:'Manager or owner authorization is required.'},{status:403});return Response.json(await giftCardReport(business))}

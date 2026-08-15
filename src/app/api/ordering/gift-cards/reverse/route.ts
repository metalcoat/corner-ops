import { GiftCardError, reverseGiftEntry } from "@/lib/ordering-gift-cards";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { orderingActor } from "@/lib/ordering-route-auth";
import { apiError, unauthorized } from "@/lib/http";
export async function POST(request:Request){try{const body=await request.json() as Record<string,unknown>;if(body.business!=='Corner Deli'&&body.business!=='Tiki')throw new GiftCardError('Unknown business.');const business=body.business as OrderingBusiness,actor=await orderingActor(business);if(!actor)return unauthorized();return Response.json(await reverseGiftEntry({business,entryId:String(body.entryId||''),operationKey:String(body.operationKey||''),reason:String(body.reason||''),actor}))}catch(error){if(error instanceof GiftCardError)return Response.json({error:error.message},{status:error.message.includes('authorization')?403:409});return apiError(error)}}

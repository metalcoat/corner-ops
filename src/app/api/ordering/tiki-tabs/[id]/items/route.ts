import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { appendTikiTabItems, TabConflictError } from "@/lib/ordering-tabs";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const actor=await orderingActor("Tiki");if(!actor)return unauthorized();const body=await request.json() as {items?:VariantConfiguredOrderItemInput[]};const{id}=await params;return isoJson({tab:await appendTikiTabItems({orderId:id,items:Array.isArray(body.items)?body.items:[],actor})},{status:201})}catch(error){if(error instanceof TabConflictError)return isoJson({error:error.message},{status:409});return apiError(error)}}

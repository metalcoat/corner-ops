import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { getCustomerDisplay, markCustomerDisplayHandled, publishCustomerDisplay, submitCustomerDisplayResponse, type CustomerDisplayPayload } from "@/lib/customer-display";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request:Request){try{const key=new URL(request.url).searchParams.get("stationKey")||"";return isoJson({session:await getCustomerDisplay(key)},{headers:{"Cache-Control":"no-store"}})}catch(error){return apiError(error)}}
export async function POST(request:Request){try{const body=await request.json() as Record<string,unknown>,stationKey=String(body.stationKey||"");if(body.action==="respond")return isoJson(await submitCustomerDisplayResponse(stationKey,(body.response||{}) as Record<string,unknown>));const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();if(body.action==="handled"){await markCustomerDisplayHandled(stationKey,Number(body.version));return isoJson({ok:true})}return isoJson(await publishCustomerDisplay(stationKey,body.payload as CustomerDisplayPayload))}catch(error){return apiError(error)}}

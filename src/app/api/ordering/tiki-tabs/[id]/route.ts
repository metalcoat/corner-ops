import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { getTikiTab } from "@/lib/ordering-tabs";
export const runtime="nodejs";
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}){try{if(!await orderingActor("Tiki"))return unauthorized();const{id}=await params;const tab=await getTikiTab(id);return tab?Response.json({tab}):Response.json({error:"Tab not found."},{status:404})}catch(error){return apiError(error)}}

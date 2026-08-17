import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { getOrderDetail } from "@/lib/ordering-order-center";
export const runtime="nodejs";
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}){try{if(!await orderingActor("Corner Deli"))return unauthorized();const{id}=await params;const order=await getOrderDetail("Corner Deli",id);return order?Response.json({order}):Response.json({error:"Order not found."},{status:404})}catch(error){return apiError(error)}}

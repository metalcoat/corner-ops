import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { addCustomerAddress } from "@/lib/ordering-customers";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  try{if(!await orderingActor("Corner Deli"))return unauthorized();const{id}=await params;const b=await request.json() as Record<string,unknown>;const addressId=await addCustomerAddress({business:"Corner Deli",customerId:id,label:String(b.label||""),line1:String(b.line1||""),line2:String(b.line2||""),city:String(b.city||""),state:String(b.state||""),postalCode:String(b.postalCode||"")});return Response.json({addressId},{status:201})}catch(error){return apiError(error)}
}

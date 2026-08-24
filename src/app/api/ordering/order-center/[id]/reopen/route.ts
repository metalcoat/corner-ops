import { apiError, unauthorized } from "@/lib/http";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { OrderConflictError, reopenOrderForAdditions } from "@/lib/ordering-order-lifecycle";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime="nodejs";

export async function POST(_request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();
    const{id}=await params;const result=await reopenOrderForAdditions(id,"Corner Deli",actor);
    await dispatchOrderPrintJobs(id,"Corner Deli");
    return Response.json(result,{status:201});
  }catch(error){if(error instanceof OrderConflictError)return Response.json({error:error.message},{status:409});return apiError(error)}
}

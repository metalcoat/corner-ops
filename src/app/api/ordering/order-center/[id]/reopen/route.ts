import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { OrderConflictError, reopenOrderForAdditions } from "@/lib/ordering-order-lifecycle";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime="nodejs";

export async function POST(_request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();
    const{id}=await params;const result=await reopenOrderForAdditions(id,"Corner Deli",actor);
    // Reopening creates no print jobs; dispatching here used to re-send stale
    // kitchen tickets that were held back earlier.
    return isoJson(result,{status:201});
  }catch(error){if(error instanceof OrderConflictError)return isoJson({error:error.message},{status:409});return apiError(error)}
}

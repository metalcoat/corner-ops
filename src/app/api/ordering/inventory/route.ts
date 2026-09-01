import {apiError,unauthorized} from "@/lib/http";
import {inventoryAction,inventoryDashboard,InventoryError} from "@/lib/ordering-inventory";
import {orderingActor} from "@/lib/ordering-route-auth";
export const runtime="nodejs";
export async function GET(){if(!await orderingActor("Corner Deli"))return unauthorized();try{return Response.json(await inventoryDashboard())}catch(error){return apiError(error)}}
export async function POST(request:Request){const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();try{return Response.json(await inventoryAction(await request.json(),actor),{status:201})}catch(error){if(error instanceof InventoryError)return Response.json({error:error.message},{status:409});return apiError(error)}}

import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { configureRestaurant, openTableSession, restaurantPlatform } from "@/lib/restaurant-platform";

export const runtime="nodejs";
export async function GET(){try{const actor=await orderingActor("Tiki");if(!actor)return unauthorized();return Response.json({...await restaurantPlatform(),actor})}catch(error){return apiError(error)}}
export async function POST(request:Request){try{const actor=await orderingActor("Tiki");if(!actor)return unauthorized();const body=await request.json() as Record<string,unknown>,action=String(body.action||"");if(action==="open_table")return Response.json(await openTableSession({tableId:String(body.tableId||""),guestCount:Number(body.guestCount),actor}),{status:201});return Response.json(await configureRestaurant({action,body,actor}),{status:201})}catch(error){return Response.json({error:error instanceof Error?error.message:"Restaurant update failed."},{status:409})}}

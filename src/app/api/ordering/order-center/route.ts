import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { listOrders } from "@/lib/ordering-order-center";
import { getPosSettings } from "@/lib/ordering-pos-settings";
export const runtime="nodejs";
export async function GET(request:Request){try{if(!await orderingActor("Corner Deli"))return unauthorized();const p=new URL(request.url).searchParams;const [orders,settings]=await Promise.all([listOrders({business:"Corner Deli",date:p.get("date")||undefined,allOpen:p.get("view")==="open",query:p.get("q")||"",searchDays:60}),getPosSettings("Corner Deli")]);return Response.json({orders,businessTimezone:settings.businessTimezone,testOrderClearEnabled:process.env.LOCAL_DEVELOPMENT==="true"})}catch(error){return apiError(error)}}

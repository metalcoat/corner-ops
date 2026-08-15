import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { listOpenTikiTabs } from "@/lib/ordering-tabs";
export const runtime="nodejs";
export async function GET(){try{if(!await orderingActor("Tiki"))return unauthorized();return Response.json({tabs:await listOpenTikiTabs()})}catch(error){return apiError(error)}}

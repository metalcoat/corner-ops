import { getPosSession } from "@/lib/pos-auth";
import { orderingStoreDashboard } from "@/lib/ordering-store-dashboard";

export const runtime="nodejs";
export async function GET(){try{const session=await getPosSession(false);if(!session||session.clockInRequired)return Response.json({error:"Employee sign-in required."},{status:401});return Response.json(await orderingStoreDashboard())}catch(error){console.error(error);return Response.json({error:"The store dashboard is temporarily unavailable."},{status:500})}}

import { apiError, unauthorized } from "@/lib/http";
import { customerCredit, issueCustomerCredit, redeemCustomerCredit } from "@/lib/ordering-store-credit";
import { orderingActor } from "@/lib/ordering-route-auth";
export const runtime="nodejs";
export async function GET(request:Request){try{const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();const id=new URL(request.url).searchParams.get("customerId")||"";return Response.json(await customerCredit(id))}catch(error){return apiError(error)}}
export async function POST(request:Request){try{const actor=await orderingActor("Corner Deli");if(!actor)return unauthorized();const body=await request.json();if(body.action==="redeem")return Response.json(await redeemCustomerCredit({orderId:String(body.orderId||""),checkId:body.checkId?String(body.checkId):null,actor}),{status:201});return Response.json(await issueCustomerCredit({customerId:String(body.customerId||""),orderId:body.orderId?String(body.orderId):undefined,amountCents:Number(body.amountCents),reason:String(body.reason||""),actor}),{status:201})}catch(error){return apiError(error)}}

import { timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/http";
import { ingestThreeCxLiveCall } from "@/lib/three-cx-live-calls";

export const runtime="nodejs";
export const dynamic="force-dynamic";

function equal(left:string,right:string){const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b)}
function phone(value:string){let digits=value.replace(/\D/g,"");if(digits.length===11&&digits[0]==="1")digits=digits.slice(1);return digits.length===10?digits:""}

export async function GET(request:Request){
  try{
    const expected=process.env.THREE_CX_CRM_SECRET?.trim(),supplied=request.headers.get("x-corner-ops-crm-secret")?.trim();
    if(!expected||!supplied||!equal(expected,supplied))return Response.json({error:"Invalid 3CX CFD secret."},{status:401});
    const url=new URL(request.url),callerNumber=phone(url.searchParams.get("number")||""),callId=(url.searchParams.get("callId")||"").trim();
    if(!callerNumber||!callId)return Response.json({error:"A valid caller number and CFD call ID are required."},{status:400});
    const result=await ingestThreeCxLiveCall({callId:`ai-${callId}`,callerNumber,status:"ringing",startedAt:new Date().toISOString(),source:"ai_ingress"});
    return Response.json(result,{status:202,headers:{"Cache-Control":"no-store"}});
  }catch(error){return apiError(error)}
}

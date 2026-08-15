import { NextResponse } from "next/server";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { controlPrintJob, hardwareDashboard, saveHardware } from "@/lib/ordering-hardware";
export const runtime="nodejs";const business="Corner Deli" as const;
async function actor(){const value=await orderingActor(business);return value&&canManagePos(value)?value:null}
export async function GET(){const value=await actor();if(!value)return NextResponse.json({error:"Manager access required."},{status:403});try{return NextResponse.json(await hardwareDashboard(business))}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Could not load hardware."},{status:400})}}
export async function PATCH(request:Request){const value=await actor();if(!value)return NextResponse.json({error:"Manager access required."},{status:403});try{const body=await request.json() as Record<string,unknown>,action=String(body.action||"");const result=action==="retry"||action==="reprint"?await controlPrintJob({business,jobId:String(body.jobId||""),action,reason:String(body.reason||""),actor:value}):await saveHardware({business,action,body,actor:value});return NextResponse.json(result,{status:action.startsWith("save_")?201:200})}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Could not update hardware."},{status:400})}}

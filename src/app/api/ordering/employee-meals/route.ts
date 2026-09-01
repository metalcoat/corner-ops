import { recordEmployeeMeal } from "@/lib/ordering-employee-meals";
import { unauthorized } from "@/lib/http";
import { getPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";
export async function POST(request:Request){const session=await getPosSession(false);if(!session)return unauthorized();const actor={id:session.employeeId,name:session.name,type:"employee" as const,role:session.posRole};try{const body=await request.json() as {lines?:Array<{itemId?:unknown;quantity?:unknown}>;note?:unknown};const result=await recordEmployeeMeal({business:"Corner Deli",lines:(body.lines||[]).map(line=>({itemId:String(line.itemId||""),quantity:Number(line.quantity)})),note:String(body.note||""),actor});return Response.json(result,{status:201});}catch(error){return Response.json({error:error instanceof Error?error.message:"Employee meal could not be recorded."},{status:400});}}

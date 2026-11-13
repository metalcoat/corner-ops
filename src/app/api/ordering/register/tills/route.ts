import { isoJson } from "@/lib/timestamp-values";
import { unauthorized } from "@/lib/http";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { RegisterError, listTillSettings, retireTill, saveTillSettings } from "@/lib/ordering-registers";
export const runtime="nodejs";const business="Corner Deli" as const;
export async function GET(){const actor=await orderingActor(business);if(!actor)return unauthorized();if(!canManagePos(actor))return isoJson({error:"Manager or owner access is required."},{status:403});try{return isoJson({tills:await listTillSettings()})}catch(error){return isoJson({error:error instanceof Error?error.message:"Tills unavailable."},{status:500})}}
export async function POST(request:Request){const actor=await orderingActor(business);if(!actor)return unauthorized();try{const body=await request.json() as Record<string,unknown>;if(body.action==="retire")return isoJson(await retireTill({terminalId:String(body.terminalId||""),actor}));return isoJson(await saveTillSettings({terminalId:String(body.terminalId||""),settings:body.settings,reset:body.reset===true,actor}))}catch(error){return isoJson({error:error instanceof Error?error.message:"Till settings could not be saved."},{status:error instanceof RegisterError?409:500})}}

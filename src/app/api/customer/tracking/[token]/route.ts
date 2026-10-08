import { isoJson } from "@/lib/timestamp-values";
import { customerTracking } from "@/lib/ordering-driver-delivery";
export const runtime="nodejs";
export async function GET(_:Request,{params}:{params:Promise<{token:string}>}){try{const value=await customerTracking((await params).token);return value?isoJson({tracking:value}):isoJson({error:"Tracking link is invalid or expired."},{status:404})}catch(error){console.error(error);return isoJson({error:"Tracking is temporarily unavailable."},{status:500})}}

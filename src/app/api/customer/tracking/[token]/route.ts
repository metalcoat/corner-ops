import { customerTracking } from "@/lib/ordering-driver-delivery";
export const runtime="nodejs";
export async function GET(_:Request,{params}:{params:Promise<{token:string}>}){try{const value=await customerTracking((await params).token);return value?Response.json({tracking:value}):Response.json({error:"Tracking link is invalid or expired."},{status:404})}catch(error){console.error(error);return Response.json({error:"Tracking is temporarily unavailable."},{status:500})}}

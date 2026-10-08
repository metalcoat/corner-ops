import { isoJson } from "@/lib/timestamp-values";
import { importGiftCards, type GiftCardImportRow } from "@/lib/ordering-gift-card-import";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { orderingActor } from "@/lib/ordering-route-auth";
import { unauthorized } from "@/lib/http";
export async function POST(request:Request){try{const body=await request.json() as Record<string,unknown>;if(body.business!=='Corner Deli'&&body.business!=='Tiki')throw new Error('Unknown business.');const business=body.business as OrderingBusiness,actor=await orderingActor(business);if(!actor)return unauthorized();return isoJson(await importGiftCards({business,rows:(body.rows||[]) as GiftCardImportRow[],dryRun:body.dryRun!==false,batchKey:String(body.batchKey||''),actor}))}catch(error){const message=error instanceof Error?error.message:'Import failed.';return isoJson({error:message},{status:message.includes('authorization')?403:400})}}

import { isoJson } from "@/lib/timestamp-values";
import {orderingActor} from "@/lib/ordering-route-auth";
import {editOrderLine,OrderLineEditError} from "@/lib/ordering-line-edits";
import {PaymentConflictError} from "@/lib/ordering-payments";
import {managerApprovalFromPin} from "@/lib/pos-auth";
import {pinAttemptKeys} from "@/lib/pos-access-guard";
import type {VariantConfiguredOrderItemInput} from "@/lib/ordering-orders-with-variants";
export const runtime="nodejs";
/** EDIT on a saved POS line: the same choices the item screen sends, replacing the line. */
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const actor=await orderingActor("Corner Deli");if(!actor)return isoJson({error:"POS authentication required."},{status:401});const body=await request.json() as Record<string,unknown>,orderId=(await params).id;if(!body.item||typeof body.item!=="object")return isoJson({error:"The changed item is missing."},{status:400});let approver;if(body.managerPin){try{approver=await managerApprovalFromPin(body.managerPin,pinAttemptKeys(request.headers))}catch(error){return isoJson({error:error instanceof Error?error.message:"Manager PIN not accepted."},{status:403})}}return isoJson(await editOrderLine({orderId,itemId:String(body.itemId||""),item:body.item as VariantConfiguredOrderItemInput,reason:String(body.reason||""),clientMutationId:String(body.clientMutationId||""),actor,approver}),{status:201})}catch(error){if(error instanceof OrderLineEditError||error instanceof PaymentConflictError)return isoJson({error:error.message},{status:error.message.includes("authorization")?403:409});console.error("[item-edit] failed",error);return isoJson({error:"The item change could not be saved."},{status:500})}}

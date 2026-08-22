import { createHash,randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";

const stable=(value:unknown)=>JSON.stringify(value,(_,row)=>row&&typeof row==="object"&&!Array.isArray(row)?Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))):row);
export async function recordAiRegression(input:{business:"Corner Deli"|"Tiki";caseType:"order_resolution"|"speech_completion";source:string;callId?:string;payload:Record<string,unknown>;expected?:Record<string,unknown>}){
  await ensureOrderingAiSchema();const key=createHash("sha256").update(`${input.caseType}:${stable(input.payload)}`).digest("hex").slice(0,32);
  await getSql()`INSERT INTO ordering_ai_regression_cases(id,business,case_key,case_type,source,call_id,input,expected)VALUES(${randomUUID()},${input.business},${key},${input.caseType},${input.source.slice(0,80)},${input.callId||""},${JSON.stringify(input.payload)}::jsonb,${JSON.stringify(input.expected||{})}::jsonb)ON CONFLICT(business,case_key)DO UPDATE SET last_seen_at=NOW(),source=EXCLUDED.source,call_id=EXCLUDED.call_id`;
}

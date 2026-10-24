#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { ensureOrderingAiSchema } = await import("../src/lib/ordering-ai-schema");
  const { AiToolError, auditAiTool, createAiDraft, holdDraft, itemInputs, replaceAiDraft, serviceType } = await import("../src/lib/ordering-ai-tools");
  await ensureOrderingAiSchema();
  const sql=getSql(); const actor={id:"ai-ordering-validation",name:"AI Ordering Validation",type:"employee" as const};
  let orderId=""; const eventRequestId=randomUUID();
  try {
    assert.equal(serviceType("delivery"),"delivery");
    assert.throws(()=>serviceType("shipping"),(error)=>error instanceof AiToolError&&error.code==="INVALID_INPUT"&&Boolean(error.remedy));
    assert.deepEqual(itemInputs([]),[]);
    assert.throws(()=>itemInputs("pizza"),(error)=>error instanceof AiToolError&&error.code==="INVALID_INPUT");

    const draft=await createAiDraft({business:"Corner Deli",actor,service:"undecided",items:[],firstName:"AI Validation"});
    orderId=String(draft.id);
    assert.equal(draft.pricingAuthority,"corner_ops_server");
    assert.equal(draft.total_cents,0);
    const held=await holdDraft(orderId,"Corner Deli");
    assert.equal(held.hold.accepted,true);
    assert.equal(held.hold.sendReady,false);
    assert.deepEqual(held.hold.missingFields.sort(),["items","serviceType"].sort());

    const updated=await replaceAiDraft({business:"Corner Deli",actor,orderId,expectedVersion:Number(draft.version),service:"pickup",items:[],firstName:"AI Validation",callerPhone:"3155550100"});
    assert.equal(updated.id,orderId,"Draft update must preserve its stable order ID.");
    assert.equal(updated.service_type,"pickup");
    assert.ok(Number(updated.version)>Number(draft.version));
    await assert.rejects(()=>replaceAiDraft({business:"Corner Deli",actor,orderId,expectedVersion:Number(draft.version),service:"pickup",items:[]}), (error)=>error instanceof AiToolError&&error.code==="VERSION_CONFLICT"&&Boolean(error.remedy));

    await auditAiTool({business:"Corner Deli",requestId:eventRequestId,conversationId:"validation-conversation",tool:"hold",actor,orderId,outcome:"blocked",errorCode:"VALIDATION_REQUIRED",inputSummary:{keys:["orderId"]},resultSummary:{missingFields:["items"]},durationMs:3,model:"validation-model"});
    const event=(await sql`SELECT tool_name,outcome,error_code,input_summary,result_summary,duration_ms,model FROM ordering_ai_tool_events WHERE request_id=${eventRequestId}`)[0];
    assert.equal(event.tool_name,"hold"); assert.equal(event.outcome,"blocked"); assert.equal(event.error_code,"VALIDATION_REQUIRED"); assert.equal(event.duration_ms,3); assert.equal(event.model,"validation-model");
    console.log("AI ordering foundation validation passed.");
  } finally {
    await sql`DELETE FROM ordering_ai_tool_events WHERE request_id=${eventRequestId}`;
    if(orderId) await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
  }
}

main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});

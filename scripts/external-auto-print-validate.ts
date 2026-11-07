#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

const rollback="rollback:external-auto-print";
async function main(){
  const[{getSql,withTransaction},{dispatchSubmittedOrderPrintJobs,externalPrintSettings,saveExternalPrintSettings}]=await Promise.all([import("../src/lib/db"),import("../src/lib/ordering-auto-print")]);
  await externalPrintSettings("Corner Deli");
  const actor={id:"auto-print-test",name:"Auto Print Test",type:"employee" as const,role:"manager" as const};
  const result:Record<string,boolean>={};
  try{await withTransaction(async()=>{
    const sql=getSql(),order=(await sql`SELECT id,source,order_origin FROM ordering_orders WHERE business='Corner Deli' ORDER BY created_at DESC LIMIT 1`)[0];
    assert.ok(order,"An order fixture is required.");
    await saveExternalPrintSettings("Corner Deli",false,actor);
    assert.equal((await externalPrintSettings("Corner Deli")).externalKitchenAutoPrint,false);
    await sql`UPDATE ordering_orders SET source='pos',order_origin='pos' WHERE id=${order.id}`;
    const jobId=randomUUID();
    await sql`INSERT INTO ordering_print_jobs(id,business,order_id,purpose,event_subtype,status,is_reprint,actor_type,actor_id,error_message,payload)VALUES(${jobId},'Corner Deli',${order.id},'kitchen_production','initial_send','queued',TRUE,'employee',${actor.id},'',${JSON.stringify({heading:"AUTO PRINT TEST"})}::jsonb)`;
    const paused=await dispatchSubmittedOrderPrintJobs(String(order.id),"Corner Deli");
    assert.equal(paused.paused,true);
    const job=(await sql`SELECT status,error_message FROM ordering_print_jobs WHERE id=${jobId}`)[0];
    assert.equal(job.status,"not_configured");assert.match(String(job.error_message),/paused/i);
    result.posPausedWithoutPrinting=true;
    await sql`UPDATE ordering_orders SET source='kiosk',order_origin='kiosk' WHERE id=${order.id}`;
    await sql`UPDATE ordering_print_jobs SET status='queued',error_message='' WHERE id=${jobId}`;
    const kioskPaused=await dispatchSubmittedOrderPrintJobs(String(order.id),"Corner Deli");
    assert.equal(kioskPaused.paused,true);
    assert.equal((await sql`SELECT status FROM ordering_print_jobs WHERE id=${jobId}`)[0].status,"not_configured");
    result.kioskPausedWithoutPrinting=true;
    await sql`UPDATE ordering_orders SET source='ai_phone',order_origin='ai' WHERE id=${order.id}`;
    await sql`UPDATE ordering_print_jobs SET status='queued',error_message='' WHERE id=${jobId}`;
    const aiPaused=await dispatchSubmittedOrderPrintJobs(String(order.id),"Corner Deli");
    assert.equal(aiPaused.paused,true);
    assert.equal((await sql`SELECT status FROM ordering_print_jobs WHERE id=${jobId}`)[0].status,"not_configured");
    result.aiPausedWithoutPrinting=true;
    await saveExternalPrintSettings("Corner Deli",true,actor);
    assert.equal((await externalPrintSettings("Corner Deli")).externalKitchenAutoPrint,true);
    result.managerTogglePersists=true;
    throw new Error(rollback);
  })}catch(error){if(!(error instanceof Error)||error.message!==rollback)throw error}
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});

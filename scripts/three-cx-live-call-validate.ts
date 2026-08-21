#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const host=execFileSync("docker",["inspect","corner-ops-postgres","--format","{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],{encoding:"utf8"}).trim();
if(!process.env.POSTGRES_PASSWORD)throw new Error("POSTGRES_PASSWORD is required.");
process.env.DATABASE_DRIVER="postgres";
process.env.DATABASE_URL=`postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${host}:5432/cornerops`;

async function main(){
  const [{getSql},{ensureOrderingSchema},{activeDeliCalls,acknowledgeDeliCall,ingestThreeCxLiveCall}]=await Promise.all([import("../src/lib/db"),import("../src/lib/ordering-db"),import("../src/lib/three-cx-live-calls")]);
  await ensureOrderingSchema();
  const sql=getSql(),customerId=randomUUID(),phoneId=randomUUID(),orderId=randomUUID(),callId=`validation-${randomUUID()}`,actorId=randomUUID(),caller="3155550188",queue=process.env.THREE_CX_DELI_QUEUE||"90";
  try{
    await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name)VALUES(${customerId},'Corner Deli','Caller Validation','Caller','Validation')`;
    await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,is_primary)VALUES(${phoneId},${customerId},${caller},TRUE)`;
    await sql`INSERT INTO ordering_orders(id,business,source,customer_id,status,payment_status,service_type,display_number,phone_snapshot,created_by)VALUES(${orderId},'Corner Deli','pos',${customerId},'draft','unpaid','pickup',${`CALL${Date.now()}`},${caller},'validation')`;
    const accepted=await ingestThreeCxLiveCall({callId,callerNumber:`+1 (${caller.slice(0,3)}) ${caller.slice(3,6)}-${caller.slice(6)}`,queue,line:"2",status:"ringing"});
    const calls=await activeDeliCalls(),match=calls.find(row=>String(row.call_id)===callId);
    const acknowledged=match?await acknowledgeDeliCall(String(match.id),actorId):false;
    const remaining=(await activeDeliCalls()).some(row=>String(row.call_id)===callId);
    const ignored=await ingestThreeCxLiveCall({callId:`ignored-${callId}`,callerNumber:caller,queue:`${queue}999`,status:"ringing"});
    const result={accepted:accepted.accepted===true,customerMatched:String(match?.customer_id||"")===customerId,openOrderMatched:String(match?.open_order_id||"")===orderId,lineMatched:String(match?.line_number||"")==="2",acknowledged:acknowledged&&!remaining,otherQueueIgnored:ignored.accepted===false};
    console.log(JSON.stringify(result,null,2));
    if(Object.values(result).some(value=>!value))throw new Error("3CX live-call validation failed.");
  }finally{
    await sql`DELETE FROM three_cx_live_calls WHERE call_id IN(${callId},${`ignored-${callId}`})`;
    await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
    await sql`DELETE FROM ordering_customers WHERE id=${customerId}`;
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});

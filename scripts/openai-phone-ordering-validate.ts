#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const host=execFileSync("docker",["inspect","corner-ops-postgres","--format","{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],{encoding:"utf8"}).trim();
if(!process.env.POSTGRES_PASSWORD)throw new Error("POSTGRES_PASSWORD is required.");
process.env.DATABASE_DRIVER="postgres";
process.env.DATABASE_URL=`postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${host}:5432/cornerops`;
process.env.OPENAI_ORDERING_MCP_TOKEN=`validation-${randomUUID()}`;
process.env.OPENAI_PHONE_TEST_DIDS="3155550200";
process.env.OPENAI_PHONE_DID_LINES="3155550200=TEST LINE";

async function main(){
  const [{getSql},phone,{POST}]=await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/openai-phone-ordering"),
    import("../src/app/api/openai/ordering/mcp/route"),
  ]);
  const sql=getSql(),callId=`rtc_${randomUUID()}`,authorization=`Bearer ${process.env.OPENAI_ORDERING_MCP_TOKEN}`;
  try{
    const caller=phone.callerFromSipHeaders([{name:"From",value:'"Customer" <sip:+13155550188@example.test>'}]);
    const forwardedCaller=phone.callerFromSipHeaders([{name:"X-Corner-Ops-Caller",value:"+1 (315) 555-0199"},{name:"From",value:'<sip:asterisk@example.test>'}]);
    const calledDid=phone.calledDidFromSipHeaders([
      {name:"To",value:'<sip:proj_example@sip.api.openai.com>'},
      {name:"P-Called-Party-ID",value:'<sip:+13155550200@example.test>'},
    ]);
    await phone.registerOpenAiCall(callId,caller,calledDid,phone.lineForDid(calledDid));
    const invoke=(body:unknown,token=authorization)=>POST(new Request("http://localhost/api/openai/ordering/mcp",{method:"POST",headers:{authorization:token,"content-type":"application/json"},body:JSON.stringify(body)}));
    const unauthorized=await invoke({jsonrpc:"2.0",id:1,method:"tools/list"},"Bearer wrong");
    const initialized=await(await invoke({jsonrpc:"2.0",id:2,method:"initialize",params:{}})).json();
    const listed=await(await invoke({jsonrpc:"2.0",id:3,method:"tools/list"})).json();
    const called=await(await invoke({jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"describe_capabilities",arguments:{callId}}})).json();
    const blocked=await(await invoke({jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"send",arguments:{callId,orderId:randomUUID(),customerConfirmed:false}}})).json();
    const shadowed=await(await invoke({jsonrpc:"2.0",id:6,method:"tools/call",params:{name:"send",arguments:{callId,orderId:randomUUID(),customerConfirmed:true}}})).json();
    const genericPizza=await(await invoke({jsonrpc:"2.0",id:7,method:"tools/call",params:{name:"price_order",arguments:{callId,serviceType:"pickup",items:[{name:"Pizza",quantity:1}]}}})).json();
    const describedItem=await(await invoke({jsonrpc:"2.0",id:8,method:"tools/call",params:{name:"menu_search",arguments:{callId,query:"Turkey Big Boss"}}})).json();
    const pending=(await sql`SELECT pending_item,order_id FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`)[0];
    const result={
      callerNormalized:caller==="3155550188"&&forwardedCaller==="3155550199",
      calledDidRestricted:calledDid==="3155550200"&&phone.testDidAllowed(calledDid)&&!phone.testDidAllowed("3155550201"),
      lineMapped:phone.lineForDid(calledDid)==="TEST LINE",
      englishGreeting:phone.OPENAI_PHONE_GREETING==="Thanks for calling Corner Deli, is this going to be pickup or delivery?"&&phone.PHONE_INSTRUCTIONS.includes("Ask exactly one question at a time"),
      menuVocabularyDefaults:phone.PHONE_INSTRUCTIONS.includes("Jumbo Thin 16 inch")&&phone.PHONE_INSTRUCTIONS.includes("Large French Fries")&&phone.PHONE_INSTRUCTIONS.includes("warm, upbeat, enthusiastic"),
      pizzaSizePolicy:phone.PHONE_INSTRUCTIONS.includes("6 slices")&&phone.PHONE_INSTRUCTIONS.includes("8 slices")&&phone.PHONE_INSTRUCTIONS.includes("12 slices")&&phone.PHONE_INSTRUCTIONS.includes("Thin is only large/jumbo"),
      wingWorkflow:phone.PHONE_INSTRUCTIONS.includes("bone-in")&&phone.PHONE_INSTRUCTIONS.includes("What sauce?")&&phone.PHONE_INSTRUCTIONS.includes("Split flavors into separate lines")&&phone.PHONE_INSTRUCTIONS.includes("Blue cheese, ranch, or celery?")&&phone.PHONE_INSTRUCTIONS.includes("Mild and Medium are distinct"),
      responsiveSpeech:phone.PHONE_INSTRUCTIONS.includes("finish it")&&phone.PHONE_INSTRUCTIONS.includes("Incidental noise"),
      conciseReadback:phone.PHONE_INSTRUCTIONS.includes("Do not narrate work or repeat every item"),
      fullRealtimeDefault:phone.OPENAI_PHONE_MODEL==="gpt-realtime-1.5",
      unauthorized:unauthorized.status===401,
      protocol:initialized.result?.protocolVersion==="2025-06-18",
      toolsListed:listed.result?.tools?.some((tool:{name:string})=>tool.name==="price_order")&&listed.result?.tools?.some((tool:{name:string})=>tool.name==="menu_search"),
      handoffToolListed:listed.result?.tools?.some((tool:{name:string})=>tool.name==="request_human_handoff"),
      handoffPolicy:phone.PHONE_INSTRUCTIONS.includes("after two failed clarification attempts")&&phone.PHONE_INSTRUCTIONS.includes("asks for a person"),
      callBound:called.result?.content?.[0]?.text?.includes("pricingAuthority")||called.result?.content?.[0]?.text?.includes("serviceTypes"),
      unconfirmedSendBlocked:blocked.result?.isError===true,
      shadowSendHeld:shadowed.result?.content?.[0]?.text?.includes("ORDER_REVIEW_PENDING")===true,
      genericPizzaPending:genericPizza.result?.isError===true&&genericPizza.result?.content?.[0]?.text?.includes("What size?")&&pending.pending_item?.missingRequiredFields?.[0]==="size"&&!pending.order_id,
      liveDescriptions:describedItem.result?.isError!==true&&describedItem.result?.content?.[0]?.text?.includes('"description"'),
    };
    console.log(JSON.stringify(result,null,2));
    if(Object.values(result).some(value=>!value))throw new Error("OpenAI phone ordering validation failed.");
  }finally{
    await sql`DELETE FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`;
  }
}

main().catch(error=>{console.error(error);process.exitCode=1});

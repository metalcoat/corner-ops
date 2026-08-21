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
    const result={
      callerNormalized:caller==="3155550188",
      calledDidRestricted:calledDid==="3155550200"&&phone.testDidAllowed(calledDid)&&!phone.testDidAllowed("3155550201"),
      lineMapped:phone.lineForDid(calledDid)==="TEST LINE",
      englishGreeting:phone.OPENAI_PHONE_GREETING.includes("Corner Deli")&&phone.OPENAI_PHONE_GREETING.includes("pickup or delivery")&&phone.PHONE_INSTRUCTIONS.includes("Always speak English"),
      menuVocabularyDefaults:phone.PHONE_INSTRUCTIONS.includes("Jumbo Thin 16")&&phone.PHONE_INSTRUCTIONS.includes("Large French Fries")&&phone.PHONE_INSTRUCTIONS.includes("genuinely welcoming"),
      pizzaSizePolicy:phone.PHONE_INSTRUCTIONS.includes("6 slices")&&phone.PHONE_INSTRUCTIONS.includes("8 slices")&&phone.PHONE_INSTRUCTIONS.includes("12 slices")&&phone.PHONE_INSTRUCTIONS.includes("thin crust is only available in Large/Jumbo")&&phone.PHONE_INSTRUCTIONS.includes("standard crust or a Jumbo Thin"),
      wingWorkflow:phone.PHONE_INSTRUCTIONS.includes("standard bone-in")&&phone.PHONE_INSTRUCTIONS.includes("What flavor?")&&phone.PHONE_INSTRUCTIONS.includes("separate order line")&&phone.PHONE_INSTRUCTIONS.includes("Blue cheese, ranch, or celery with those?")&&phone.PHONE_INSTRUCTIONS.includes("preserving Mild and Medium as distinct sauces"),
      responsiveSpeech:phone.PHONE_INSTRUCTIONS.includes("there is no dead air")&&phone.PHONE_INSTRUCTIONS.includes("before searching the menu or using a tool")&&phone.PHONE_INSTRUCTIONS.includes("do not claim an item was added until the tool confirms it"),
      conciseReadback:phone.PHONE_INSTRUCTIONS.includes("concise natural readback")&&phone.PHONE_INSTRUCTIONS.includes("do not recite internal variant labels"),
      unauthorized:unauthorized.status===401,
      protocol:initialized.result?.protocolVersion==="2025-06-18",
      toolsListed:listed.result?.tools?.some((tool:{name:string})=>tool.name==="create_draft"),
      handoffToolListed:listed.result?.tools?.some((tool:{name:string})=>tool.name==="request_human_handoff"),
      callBound:called.result?.content?.[0]?.text?.includes("pricingAuthority")||called.result?.content?.[0]?.text?.includes("serviceTypes"),
      unconfirmedSendBlocked:blocked.result?.isError===true,
    };
    console.log(JSON.stringify(result,null,2));
    if(Object.values(result).some(value=>!value))throw new Error("OpenAI phone ordering validation failed.");
  }finally{
    await sql`DELETE FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`;
  }
}

main().catch(error=>{console.error(error);process.exitCode=1});

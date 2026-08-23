#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main(){
  const [{compactAcknowledgement,requiredQuestion,buildPhoneInstructions},{getAiPhoneSettings,realtimeBusinessContext},{ensureOrderingAiSchema},{getSql},{menuCatalog,priceSpokenOrder}]=await Promise.all([
    import("../src/lib/openai-phone-prompt"),import("../src/lib/ordering-ai-phone-config"),import("../src/lib/ordering-ai-schema"),import("../src/lib/db"),import("../src/lib/ordering-ai-tools"),
  ]);
  await ensureOrderingAiSchema();
  const settings=await getAiPhoneSettings(),business=await realtimeBusinessContext();
  assert.equal(settings.mode,"shadow","Development must begin in shadow mode.");
  assert.equal(requiredQuestion("sauce"),"What sauce?");
  assert.equal(requiredQuestion("address"),"What's the address?");
  assert.notEqual(compactAcknowledgement(0),compactAcknowledgement(1));
  const prompt=buildPhoneInstructions({callId:"rtc_validation",callerPhone:"3155550100",lineLabel:"TEST",settings,business});
  for(const phrase of ["Hard rules override creativity","Ask exactly one question at a time","finish it","No menu ID means no item","Never invent, infer, substitute","ITEM_NOT_ON_MENU","INVALID_MODIFIER","CATALOG_UNAVAILABLE","total_cents","SHADOW","Maximum"]){assert.ok(prompt.includes(phrase),`Missing prompt policy: ${phrase}`)}
  assert.equal(settings.model,"gpt-realtime-1.5","Test calls must use the proven full Realtime model.");
  const webhookSource=await readFile(new URL("../src/app/api/openai/realtime/webhook/route.ts",import.meta.url),"utf8");
  assert.ok(!webhookSource.includes("reasoning:{effort"),"GPT-Realtime 1.5 call acceptance must not send reasoning configuration.");
  assert.ok(webhookSource.includes("max_output_tokens:1024"),"Function arguments and complete questions must not be constrained by the old 80-token ceiling.");
  assert.ok(webhookSource.includes("tools:[OPENAI_PRICE_ORDER_TOOL]"),"Realtime calls must use the direct atomic pricing function.");
  assert.ok(!webhookSource.includes('type:"mcp"'),"Realtime calls must not wait on hosted MCP discovery.");
  assert.ok(webhookSource.includes("create_response:false"),"The sideband must debounce customer turns instead of interjecting on every VAD pause.");
  assert.ok(webhookSource.includes("interrupt_response:false"),"Incidental VAD events must not cancel an active sentence.");
  const sidebandSource=await readFile(new URL("../src/lib/openai-phone-sideband.ts",import.meta.url),"utf8");
  assert.ok(sidebandSource.includes('response.function_call_arguments.done')&&sidebandSource.includes('function_call_output'),"The sideband must execute and return native pricing calls.");
  assert.ok(sidebandSource.includes("response.completion_retry")&&sidebandSource.includes("production_truncated_response"),"Truncated speech must retry and become a regression case.");
  assert.ok(sidebandSource.includes("conversation.sustained_barge_in")&&sidebandSource.includes("800"),"Only sustained caller speech may interrupt playback.");
  assert.ok(prompt.includes("Never interject while the caller is listing items")&&prompt.includes("Nacho cheese always means"),"Natural-pause and nacho-side rules must remain in the live prompt.");
  const jumbo=await menuCatalog("Corner Deli",new Date(),"jumbo thin");
  assert.equal(jumbo[0]?.items[0]?.name,"Pizza","Jumbo Thin must resolve to the standard Pizza item first.");
  assert.ok(jumbo[0].items[0].variants.some((variant:{name:string})=>variant.name.includes("Jumbo Thin")));
  const toppedJumbo=await menuCatalog("Corner Deli",new Date(),"jumbo pepperoni pizza onion");
  assert.equal(toppedJumbo[0]?.items[0]?.name,"Pizza","A topped jumbo pizza request must resolve in one search.");
  const priced=await priceSpokenOrder({business:"Corner Deli",actor:{id:"validation",name:"Validation",type:"employee",role:"employee"},service:"pickup",callerPhone:"3155550100",firstName:"Chris",items:[{name:"Pizza",variant:"Jumbo Thin",quantity:1,modifiers:[{name:"Pepperoni"},{name:"Onions",portion:"left_half"}]},{name:"Wings",variant:"20 Wings",quantity:1,modifiers:[{name:"Mild"}]}]});
  try{
    assert.equal(priced.lines.length,2,"Atomic pricing must create both order lines.");
    assert.ok(priced.total_cents>0,"Atomic pricing must return an authoritative total.");
    assert.ok(priced.lines.some((line:Record<string,any>)=>line.item_name_snapshot==="Pizza"&&line.variant_name_snapshot?.includes("Jumbo Thin")));
    assert.ok(priced.lines.some((line:Record<string,any>)=>line.item_name_snapshot==="Wings"&&line.variant_name_snapshot?.includes("20 Wings")));
  }finally{await getSql()`DELETE FROM ordering_orders WHERE id=${priced.id}`}
  const schema=await getSql()`SELECT to_regclass('ordering_call_transcript_segments') transcript,to_regclass('ordering_ai_latency_samples') latency,to_regclass('ordering_ai_upsell_events') upsells,to_regclass('ordering_call_reviews') reviews`;
  assert.ok(schema[0].transcript&&schema[0].latency&&schema[0].upsells&&schema[0].reviews);
  console.log(JSON.stringify({mode:settings.mode,maxResponseWords:settings.maxResponseWords,maxUpsells:settings.maxUpsells,vadEagerness:settings.vadEagerness,pickupAvailable:business.pickupAvailable,deliveryAvailable:business.deliveryAvailable,policyChecks:"passed"},null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1});

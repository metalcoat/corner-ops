#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main(){
  const [{compactAcknowledgement,requiredQuestion,buildPhoneInstructions},{getAiPhoneSettings,realtimeBusinessContext},{ensureOrderingAiSchema},{getSql}]=await Promise.all([
    import("../src/lib/openai-phone-prompt"),import("../src/lib/ordering-ai-phone-config"),import("../src/lib/ordering-ai-schema"),import("../src/lib/db"),
  ]);
  await ensureOrderingAiSchema();
  const settings=await getAiPhoneSettings(),business=await realtimeBusinessContext();
  assert.equal(settings.mode,"shadow","Development must begin in shadow mode.");
  assert.equal(requiredQuestion("sauce"),"What sauce?");
  assert.equal(requiredQuestion("address"),"What's the address?");
  assert.notEqual(compactAcknowledgement(0),compactAcknowledgement(1));
  const prompt=buildPhoneInstructions({callId:"rtc_validation",callerPhone:"3155550100",lineLabel:"TEST",settings,business});
  for(const phrase of ["2–10 spoken words","Capture names, phones, addresses","If interrupted, stop immediately","MUST use the ordering tools before you speak","Immediately MENU_SEARCH","Never collect items only in conversation memory","MUST read the priced draft with HOLD","SHADOW","Never say the order is placed","Maximum"]){assert.ok(prompt.includes(phrase),`Missing prompt policy: ${phrase}`)}
  assert.equal(settings.model,"gpt-realtime-1.5","Test calls must use the proven full Realtime model.");
  const webhookSource=await readFile(new URL("../src/app/api/openai/realtime/webhook/route.ts",import.meta.url),"utf8");
  assert.ok(!webhookSource.includes("reasoning:{effort"),"GPT-Realtime 1.5 call acceptance must not send reasoning configuration.");
  const schema=await getSql()`SELECT to_regclass('ordering_call_transcript_segments') transcript,to_regclass('ordering_ai_latency_samples') latency,to_regclass('ordering_ai_upsell_events') upsells,to_regclass('ordering_call_reviews') reviews`;
  assert.ok(schema[0].transcript&&schema[0].latency&&schema[0].upsells&&schema[0].reviews);
  console.log(JSON.stringify({mode:settings.mode,maxResponseWords:settings.maxResponseWords,maxUpsells:settings.maxUpsells,vadEagerness:settings.vadEagerness,pickupAvailable:business.pickupAvailable,deliveryAvailable:business.deliveryAvailable,policyChecks:"passed"},null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1});

import { getSql } from "@/lib/db";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { resolveOrderingAvailability } from "@/lib/ordering-availability";
import { quoteTimingForOrder } from "@/lib/ordering-timing";
import type { RealtimeBusinessContext } from "@/lib/openai-phone-prompt";

export type AiPhoneMode="shadow"|"assisted"|"autonomous";
export type AiPhoneSettings={enabled:boolean;mode:AiPhoneMode;model:string;maxResponseWords:number;maxUpsells:number;vadEagerness:"low"|"medium"|"high";recordingEnabled:boolean;transcriptRetentionDays:number};

export async function getAiPhoneSettings():Promise<AiPhoneSettings>{
  await ensureOrderingAiSchema();
  const row=(await getSql()`SELECT enabled,mode,model,max_response_words,max_upsells,vad_eagerness,recording_enabled,transcript_retention_days FROM ordering_ai_phone_settings WHERE business='Corner Deli'`)[0];
  return{enabled:row?.enabled!==false,mode:(row?.mode||"shadow") as AiPhoneMode,model:String(row?.model||"gpt-realtime-2.1-mini"),maxResponseWords:Number(row?.max_response_words||10),maxUpsells:Number(row?.max_upsells||2),vadEagerness:(row?.vad_eagerness||"high") as AiPhoneSettings["vadEagerness"],recordingEnabled:Boolean(row?.recording_enabled),transcriptRetentionDays:Number(row?.transcript_retention_days||30)};
}

export async function saveAiPhoneSettings(input:Partial<AiPhoneSettings>,actorId:string):Promise<AiPhoneSettings>{
  const current=await getAiPhoneSettings(),next={...current,...input};
  if(!["shadow","assisted","autonomous"].includes(next.mode))throw new Error("Invalid AI phone mode.");
  if(!["low","medium","high"].includes(next.vadEagerness))throw new Error("Invalid VAD eagerness.");
  if(!Number.isInteger(next.maxResponseWords)||next.maxResponseWords<2||next.maxResponseWords>30)throw new Error("Response words must be between 2 and 30.");
  if(!Number.isInteger(next.maxUpsells)||next.maxUpsells<0||next.maxUpsells>3)throw new Error("Upsells must be between 0 and 3.");
  if(!Number.isInteger(next.transcriptRetentionDays)||next.transcriptRetentionDays<1||next.transcriptRetentionDays>365)throw new Error("Transcript retention must be between 1 and 365 days.");
  await getSql()`UPDATE ordering_ai_phone_settings SET enabled=${next.enabled},mode=${next.mode},model=${next.model.slice(0,120)},max_response_words=${next.maxResponseWords},max_upsells=${next.maxUpsells},vad_eagerness=${next.vadEagerness},recording_enabled=${next.recordingEnabled},transcript_retention_days=${next.transcriptRetentionDays},updated_by=${actorId},updated_at=NOW() WHERE business='Corner Deli'`;
  return getAiPhoneSettings();
}

export async function activeUpsellRules(){
  await ensureOrderingAiSchema();
  return getSql()`SELECT id,name,priority,condition_rule,offer_rule FROM ordering_upsell_rules WHERE business='Corner Deli' AND active=TRUE ORDER BY priority DESC,name LIMIT 20`;
}

export async function realtimeBusinessContext():Promise<RealtimeBusinessContext>{
  const now=new Date();
  const [pickupAvailability,deliveryAvailability,pickupTiming,deliveryTiming,upsells]=await Promise.all([
    resolveOrderingAvailability({business:"Corner Deli",serviceType:"pickup",at:now}),resolveOrderingAvailability({business:"Corner Deli",serviceType:"delivery",at:now}),
    quoteTimingForOrder({business:"Corner Deli",serviceType:"pickup",mode:"asap",now}),quoteTimingForOrder({business:"Corner Deli",serviceType:"delivery",mode:"asap",now}),activeUpsellRules(),
  ]);
  return{pickupWait:pickupTiming.customerMessage,deliveryWait:deliveryTiming.customerMessage,pickupAvailable:pickupAvailability.orderable,deliveryAvailable:deliveryAvailability.orderable,upsells:upsells.map(row=>({name:String(row.name),condition:row.condition_rule,offer:row.offer_rule}))};
}

import { randomUUID, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { submitDraftOrder } from "@/lib/ordering-order-lifecycle";
import { commitTender } from "@/lib/ordering-payments";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { MxMerchantError, newReplayId, submitMxVoicePayment } from "@/lib/mx-merchant";

const business = "Corner Deli" as const;
const actor = { id: "sandbox-voice-payment", name: "Automated phone payment", type: "employee" as const, role: "owner" as const };
const digits = (value:string)=>value.replace(/\D/g,"");

export class VoicePaymentError extends Error {}

export function voicePaymentInternalAuthorized(value:string|null){
  const expected=process.env.VOICE_PAYMENT_INTERNAL_SECRET?.trim()||process.env.THREE_CX_CRM_SECRET?.trim()||"";
  if(!expected||!value)return false;
  const left=Buffer.from(expected),right=Buffer.from(value);
  return left.length===right.length&&timingSafeEqual(left,right);
}

export function voicePaymentSandboxReady(){
  return process.env.MX_ENVIRONMENT?.trim().toLowerCase()!=="production"&&Boolean(process.env.VOICE_PAYMENT_INTERNAL_SECRET?.trim()||process.env.THREE_CX_CRM_SECRET?.trim())&&Boolean(voicePaymentTarget());
}

function voicePaymentTarget(){
  const explicit=process.env.OPENAI_PHONE_VOICE_PAYMENT_TARGET?.trim();
  if(explicit)return /^\d+$/.test(explicit)?`tel:${explicit}`:explicit;
  const handoff=process.env.OPENAI_PHONE_HANDOFF_TARGET?.trim()||"";
  const extension=process.env.ASTERISK_VOICE_PAYMENT_EXTENSION?.trim()||"101";
  if(/^\+?\d+$/.test(handoff))throw new VoicePaymentError("OPENAI_PHONE_VOICE_PAYMENT_TARGET must be an explicit SIP URI for the local payment extension.");
  const sipTarget=handoff.replace(/^(sip:)[^@]+@/i,`$1${extension}@`);
  return sipTarget===handoff?extension:sipTarget;
}

export async function ensureVoicePaymentSchema(){
  await ensureOrderingAiSchema();
  const sql=getSql();
  await sql`CREATE TABLE IF NOT EXISTS ordering_voice_payment_sessions(
    id UUID PRIMARY KEY,business TEXT NOT NULL,call_id TEXT NOT NULL,order_id UUID NOT NULL REFERENCES ordering_orders(id),caller_phone TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0),replay_id BIGINT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'awaiting_call',attempt_count INTEGER NOT NULL DEFAULT 0,
    provider_transaction_reference TEXT NOT NULL DEFAULT '',brand TEXT NOT NULL DEFAULT '',last4 TEXT NOT NULL DEFAULT '',failure_code TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NOT NULL,claimed_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(business,call_id)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS ordering_voice_payment_lookup_idx ON ordering_voice_payment_sessions(business,caller_phone,status,created_at DESC)`;
}

export async function prepareVoicePayment(callId:string){
  if(!voicePaymentSandboxReady())throw new VoicePaymentError("Secure voice payment is not configured for sandbox testing.");
  await ensureVoicePaymentSchema();
  const sql=getSql(),call=(await sql`SELECT call.id,call.order_id,call.caller_phone,orders.amount_due_cents,orders.payment_preference FROM ordering_call_sessions call JOIN ordering_orders orders ON orders.id=call.order_id WHERE call.business=${business} AND call.three_cx_call_id=${callId} AND call.state='ai' LIMIT 1`)[0];
  if(!call?.order_id)throw new VoicePaymentError("A priced order is required before voice payment.");
  if(call.payment_preference!=="card")throw new VoicePaymentError("The customer must choose card before voice payment.");
  const amount=Number(call.amount_due_cents);
  if(!Number.isSafeInteger(amount)||amount<=0)throw new VoicePaymentError("This order has no card balance due.");
  const id=randomUUID(),replayId=newReplayId();
  await sql`INSERT INTO ordering_voice_payment_sessions(id,business,call_id,order_id,caller_phone,amount_cents,replay_id,expires_at) VALUES(${id},${business},${callId},${call.order_id},${call.caller_phone},${amount},${replayId},NOW()+INTERVAL '10 minutes') ON CONFLICT(business,call_id) DO UPDATE SET order_id=EXCLUDED.order_id,caller_phone=EXCLUDED.caller_phone,amount_cents=EXCLUDED.amount_cents,replay_id=EXCLUDED.replay_id,status='awaiting_call',attempt_count=0,provider_transaction_reference='',brand='',last4='',failure_code='',expires_at=EXCLUDED.expires_at,claimed_at=NULL,completed_at=NULL,updated_at=NOW()`;
  await sql`UPDATE ordering_call_sessions SET state='handoff_pending',handoff_reason='Secure sandbox voice payment',owner_type='none',owner_id='',updated_at=NOW() WHERE three_cx_call_id=${callId}`;
  return {target:voicePaymentTarget(),amountCents:amount};
}

export async function claimVoicePayment(callerPhone:string){
  await ensureVoicePaymentSchema();
  const normalized=digits(callerPhone).slice(-10),sql=getSql(),row=(await sql`UPDATE ordering_voice_payment_sessions SET status='collecting',claimed_at=NOW(),updated_at=NOW() WHERE id=(SELECT id FROM ordering_voice_payment_sessions WHERE business=${business} AND right(regexp_replace(caller_phone,'[^0-9]','','g'),10)=${normalized} AND status='awaiting_call' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,order_id,amount_cents`)[0];
  if(!row)throw new VoicePaymentError("No pending sandbox payment was found for this caller.");
  return {sessionId:String(row.id),orderId:String(row.order_id),amountCents:Number(row.amount_cents)};
}

function validLuhn(value:string){let sum=0,alternate=false;for(let i=value.length-1;i>=0;i--){let n=Number(value[i]);if(alternate&&(n*=2)>9)n-=9;sum+=n;alternate=!alternate}return sum%10===0}

export async function chargeVoicePayment(input:{sessionId:string;cardNumber:string;expiryMonth:string;expiryYear:string;cvv:string;avsZip:string}){
  if(process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production")throw new VoicePaymentError("Voice-card testing is sandbox-only.");
  await ensureVoicePaymentSchema();
  const card=digits(input.cardNumber),month=digits(input.expiryMonth).padStart(2,"0"),year=digits(input.expiryYear),cvv=digits(input.cvv),zip=digits(input.avsZip);
  if(card.length<13||card.length>19||!validLuhn(card)||!(/^(0[1-9]|1[0-2])$/).test(month)||!/^\d{2}(\d{2})?$/.test(year)||cvv.length<3||cvv.length>4||zip.length<5)throw new VoicePaymentError("The spoken card details were not valid.");
  const sql=getSql(),session=(await sql`UPDATE ordering_voice_payment_sessions SET attempt_count=attempt_count+1,updated_at=NOW() WHERE id=${input.sessionId} AND business=${business} AND status='collecting' AND expires_at>NOW() RETURNING *`)[0];
  if(!session)throw new VoicePaymentError("The sandbox payment session is unavailable or expired.");
  try{
    const data=await submitMxVoicePayment({amountCents:Number(session.amount_cents),replayId:Number(session.replay_id),cardNumber:card,expiryMonth:month,expiryYear:year.length===2?`20${year}`:year,cvv,avsZip:zip});
    const account=data.cardAccount&&typeof data.cardAccount==="object"?data.cardAccount as Record<string,unknown>:{};
    const reference=String(data.id||data.reference||"");
    if(!reference)throw new MxMerchantError("MX did not return a transaction reference.");
    const result=await commitTender({orderId:String(session.order_id),business,tenderType:"card",amountTenderedCents:Number(session.amount_cents),clientMutationId:`voice-payment:${session.id}`,actor,providerApproval:{provider:"mx_merchant",transactionReference:reference,brand:String(account.cardType||""),last4:card.slice(-4),details:{channel:"phone_voice_sandbox",replayId:Number(session.replay_id)}}});
    await sql`UPDATE ordering_voice_payment_sessions SET status='approved',provider_transaction_reference=${reference},brand=${String(account.cardType||"")},last4=${card.slice(-4)},completed_at=NOW(),updated_at=NOW() WHERE id=${session.id}`;
    await sql`UPDATE ordering_call_sessions SET state='ended',ended_at=NOW(),updated_at=NOW() WHERE three_cx_call_id=${session.call_id}`;
    if(result.order.payment_status==="paid"&&result.order.status==="draft"){await submitDraftOrder(String(session.order_id),business,actor);await dispatchSubmittedOrderPrintJobs(String(session.order_id),business)}else await dispatchOrderPrintJobs(String(session.order_id),business,{includeKitchenProduction:false});
    return {approved:true,last4:card.slice(-4),brand:String(account.cardType||""),orderId:String(session.order_id)};
  }catch(error){
    await sql`UPDATE ordering_voice_payment_sessions SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'collecting' END,failure_code='provider_declined',updated_at=NOW() WHERE id=${session.id}`;
    throw new VoicePaymentError(error instanceof MxMerchantError?error.message:"MX could not complete the sandbox payment.");
  }
}

export async function abandonVoicePayment(sessionId:string,code="recognition_failed"){
  await ensureVoicePaymentSchema();
  await getSql()`UPDATE ordering_voice_payment_sessions SET status='failed',failure_code=${code.slice(0,80)},completed_at=NOW(),updated_at=NOW() WHERE id=${sessionId} AND status IN('awaiting_call','collecting')`;
}

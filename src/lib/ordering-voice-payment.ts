import { randomUUID, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { OrderConflictError, preflightDraftSubmit, submitDraftOrder } from "@/lib/ordering-order-lifecycle";
import { assertOrderReadyForCheckout, checkoutState, commitTender } from "@/lib/ordering-payments";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { findMxPaymentByReplayId, MxMerchantError, MxMerchantUnreachableError, newReplayId, submitMxVoicePayment, voidOrRefundMxPayment } from "@/lib/mx-merchant";

const business = "Corner Deli" as const;
const actor = { id: "sandbox-voice-payment", name: "Automated phone payment", type: "employee" as const, role: "owner" as const };
const digits = (value:string)=>value.replace(/\D/g,"");

export class VoicePaymentError extends Error {}

async function assertVoiceOrderReady(orderId:string){
  try{await assertOrderReadyForCheckout(orderId,business)}
  catch(error){throw new VoicePaymentError(error instanceof Error?error.message:"Order information is incomplete.")}
  // Every send rule (hours, delivery area and minimum, sold-out items, prices) before any
  // card is taken, the same preflight online checkout runs.
  try{await preflightDraftSubmit(orderId,business,actor)}
  catch(error){if(error instanceof OrderConflictError)throw new VoicePaymentError(error.message);throw error}
}

export function voicePaymentInternalAuthorized(value:string|null){
  // Its own secret only: the 3CX CRM secret must not unlock card payments.
  const expected=process.env.VOICE_PAYMENT_INTERNAL_SECRET?.trim()||"";
  if(!expected||!value)return false;
  const left=Buffer.from(expected),right=Buffer.from(value);
  return left.length===right.length&&timingSafeEqual(left,right);
}

export function voicePaymentSandboxReady(){
  return process.env.MX_ENVIRONMENT?.trim().toLowerCase()!=="production"&&Boolean(process.env.VOICE_PAYMENT_INTERNAL_SECRET?.trim())&&Boolean(voicePaymentTarget());
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
}

export async function prepareVoicePayment(callId:string){
  if(!voicePaymentSandboxReady())throw new VoicePaymentError("Secure voice payment is not configured for sandbox testing.");
  await ensureVoicePaymentSchema();
  const sql=getSql(),call=(await sql`SELECT call.id,call.order_id,call.caller_phone,orders.amount_due_cents,orders.payment_preference FROM ordering_call_sessions call JOIN ordering_orders orders ON orders.id=call.order_id WHERE call.business=${business} AND call.three_cx_call_id=${callId} AND call.state='ai' LIMIT 1`)[0];
  if(!call?.order_id)throw new VoicePaymentError("A priced order is required before voice payment.");
  if(call.payment_preference!=="card")throw new VoicePaymentError("The customer must choose card before voice payment.");
  await assertVoiceOrderReady(String(call.order_id));
  const amount=Number(call.amount_due_cents);
  if(!Number.isSafeInteger(amount)||amount<=0)throw new VoicePaymentError("This order has no card balance due.");
  const id=randomUUID(),replayId=newReplayId();
  await sql`INSERT INTO ordering_voice_payment_sessions(id,business,call_id,order_id,caller_phone,amount_cents,replay_id,expires_at) VALUES(${id},${business},${callId},${call.order_id},${call.caller_phone},${amount},${replayId},NOW()+INTERVAL '10 minutes') ON CONFLICT(business,call_id) DO UPDATE SET order_id=EXCLUDED.order_id,caller_phone=EXCLUDED.caller_phone,amount_cents=EXCLUDED.amount_cents,replay_id=EXCLUDED.replay_id,status='awaiting_call',attempt_count=0,provider_transaction_reference='',brand='',last4='',failure_code='',expires_at=EXCLUDED.expires_at,claimed_at=NULL,completed_at=NULL,updated_at=NOW()
    WHERE ordering_voice_payment_sessions.status NOT IN ('charging','approved','approved_unapplied','needs_review')`;
  // A charge in flight, done, or waiting for staff review is never reset to a new attempt.
  const blocked=(await sql`SELECT status FROM ordering_voice_payment_sessions WHERE business=${business} AND call_id=${callId} AND status IN ('charging','approved','approved_unapplied','needs_review')`)[0];
  if(blocked)throw new VoicePaymentError("A card payment for this call is already in progress or done.");
  await sql`UPDATE ordering_call_sessions SET state='handoff_pending',handoff_reason='Secure sandbox voice payment',owner_type='none',owner_id='',updated_at=NOW() WHERE three_cx_call_id=${callId}`;
  return {target:voicePaymentTarget(),amountCents:amount};
}

export async function claimVoicePayment(callerPhone:string,callId=""){
  await ensureVoicePaymentSchema();
  const normalized=digits(callerPhone).slice(-10),sql=getSql();
  const row=callId
    ? (await sql`UPDATE ordering_voice_payment_sessions SET status='collecting',claimed_at=NOW(),updated_at=NOW() WHERE id=(SELECT id FROM ordering_voice_payment_sessions WHERE business=${business} AND call_id=${callId} AND status='awaiting_call' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,order_id,amount_cents`)[0]
    : (await sql`UPDATE ordering_voice_payment_sessions SET status='collecting',claimed_at=NOW(),updated_at=NOW() WHERE id=(SELECT id FROM ordering_voice_payment_sessions WHERE business=${business} AND right(regexp_replace(caller_phone,'[^0-9]','','g'),10)=${normalized} AND status='awaiting_call' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,order_id,amount_cents`)[0];
  if(!row)throw new VoicePaymentError("No pending sandbox payment was found for this caller.");
  return {sessionId:String(row.id),orderId:String(row.order_id),amountCents:Number(row.amount_cents)};
}

function validLuhn(value:string){let sum=0,alternate=false;for(let i=value.length-1;i>=0;i--){let n=Number(value[i]);if(alternate&&(n*=2)>9)n-=9;sum+=n;alternate=!alternate}return sum%10===0}

/**
 * The secure keypad line's charge. One attempt per session at a time
 * (collecting → charging), every send rule checked before MX is called, a lost
 * MX reply looked up by replayId before deciding, the approved amount compared
 * with what the order still owes, and a charge that can't be recorded is voided
 * at MX or left for staff (needs_review / approved_unapplied, on the POS alert
 * list). A send or print problem after the payment is recorded doesn't turn the
 * caller's approved payment into a failure.
 */
export async function chargeVoicePayment(input:{sessionId:string;cardNumber:string;expiryMonth:string;expiryYear:string;cvv:string;avsZip:string}){
  if(process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production")throw new VoicePaymentError("Voice-card testing is sandbox-only.");
  await ensureVoicePaymentSchema();
  const card=digits(input.cardNumber),month=digits(input.expiryMonth).padStart(2,"0"),year=digits(input.expiryYear),cvv=digits(input.cvv),zip=digits(input.avsZip);
  if(card.length<13||card.length>19||!validLuhn(card)||!(/^(0[1-9]|1[0-2])$/).test(month)||!/^\d{2}(\d{2})?$/.test(year)||cvv.length<3||cvv.length>4||zip.length<5)throw new VoicePaymentError("The spoken card details were not valid.");
  const sql=getSql();
  const pending=(await sql`SELECT * FROM ordering_voice_payment_sessions WHERE id=${input.sessionId} AND business=${business} AND status='collecting' AND expires_at>NOW()`)[0];
  if(!pending)throw new VoicePaymentError("The sandbox payment session is unavailable or expired.");
  await assertVoiceOrderReady(String(pending.order_id));
  const due=Number((await checkoutState(String(pending.order_id),business)).order.amount_due_cents);
  if(due!==Number(pending.amount_cents))throw new VoicePaymentError("The order total changed during payment. An employee will help finish it.");
  // Claim the attempt: only one charge per session at a time, and an abandon can't race it.
  const session=(await sql`UPDATE ordering_voice_payment_sessions SET status='charging',attempt_count=attempt_count+1,updated_at=NOW() WHERE id=${input.sessionId} AND business=${business} AND status='collecting' AND expires_at>NOW() RETURNING *`)[0];
  if(!session)throw new VoicePaymentError("The sandbox payment session is unavailable or expired.");
  const replayId=Number(session.replay_id);
  const delivery=(await sql`SELECT line1 FROM ordering_order_delivery_addresses WHERE order_id=${session.order_id} LIMIT 1`)[0];
  let data:Record<string,unknown>;
  try{
    data=await submitMxVoicePayment({amountCents:Number(session.amount_cents),replayId,cardNumber:card,expiryMonth:month,expiryYear:year.length===2?`20${year}`:year,cvv,avsZip:zip,avsStreet:String(delivery?.line1||"828 Morris St")});
  }catch(error){
    // MX may have charged even though we didn't get the answer: look it up before deciding.
    let found:Record<string,unknown>|null=null,lookupFailed=false;
    try{found=await findMxPaymentByReplayId(replayId)}catch{lookupFailed=true}
    if(found&&String(found.status||"").toLowerCase().includes("approve"))data=found;
    else if(lookupFailed||(error instanceof MxMerchantUnreachableError&&!found)){
      await sql`UPDATE ordering_voice_payment_sessions SET status='needs_review',failure_code='provider_unknown',updated_at=NOW() WHERE id=${session.id} AND status='charging'`;
      throw new VoicePaymentError("We couldn't confirm the card payment. An employee will check it before charging again.");
    }else{
      // A real decline: another card needs a fresh replayId (MX rejects a second card on the same one).
      await sql`UPDATE ordering_voice_payment_sessions SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'collecting' END,failure_code='provider_declined',replay_id=${newReplayId()},updated_at=NOW() WHERE id=${session.id} AND status='charging'`;
      throw new VoicePaymentError(error instanceof MxMerchantError?error.message:"MX could not complete the sandbox payment.");
    }
  }
  const account=data.cardAccount&&typeof data.cardAccount==="object"?data.cardAccount as Record<string,unknown>:{};
  const reference=String(data.id||data.reference||"");
  const brand=String(account.cardType||""),last4=card.slice(-4);
  const keepForStaff=async(status:"needs_review"|"approved_unapplied",code:string)=>{await sql`UPDATE ordering_voice_payment_sessions SET status=${status},provider_transaction_reference=${reference},brand=${brand},last4=${last4},failure_code=${code},completed_at=NOW(),updated_at=NOW() WHERE id=${session.id}`};
  if(!reference){await keepForStaff("needs_review","no_provider_reference");throw new VoicePaymentError("MX approved the payment without a reference. An employee will check it.")}
  // Charged amount must match what the order still owes; otherwise give it back.
  const owed=Number((await checkoutState(String(session.order_id),business)).order.amount_due_cents);
  if(Math.round(Number(data.amount)*100)!==Number(session.amount_cents)||owed!==Number(session.amount_cents)){
    try{await voidOrRefundMxPayment(reference);await keepForStaff("approved_unapplied","amount_mismatch_voided")}
    catch{await keepForStaff("needs_review","amount_mismatch_void_failed")}
    throw new VoicePaymentError("The order total changed during payment, so the charge was cancelled. An employee will help finish it.");
  }
  try{
    await commitTender({orderId:String(session.order_id),business,tenderType:"card",amountTenderedCents:Number(session.amount_cents),clientMutationId:`voice-payment:${session.id}`,actor,providerApproval:{provider:"mx_merchant",transactionReference:reference,brand,last4,details:{channel:"phone_dtmf_sandbox",replayId}}});
  }catch(error){
    console.error(`[voice-payment] order ${session.order_id}: MX approved ${reference} but recording it failed`,error);
    try{await voidOrRefundMxPayment(reference);await keepForStaff("approved_unapplied","order_commit_failed_voided")}
    catch{await keepForStaff("needs_review","order_commit_failed")}
    throw new VoicePaymentError("MX approved the payment, but the order requires employee review.");
  }
  // The payment is recorded: from here on the caller's payment succeeded.
  await sql`UPDATE ordering_voice_payment_sessions SET status='approved',provider_transaction_reference=${reference},brand=${brand},last4=${last4},failure_code='',completed_at=NOW(),updated_at=NOW() WHERE id=${session.id}`;
  await sql`UPDATE ordering_call_sessions SET state='ended',ended_at=COALESCE(ended_at,NOW()),updated_at=NOW() WHERE three_cx_call_id=${session.call_id}`;
  let sent=true;
  try{
    const order=(await sql`SELECT status,payment_status FROM ordering_orders WHERE id=${session.order_id}`)[0];
    if(order?.payment_status==="paid"&&order.status==="draft"){await submitDraftOrder(String(session.order_id),business,actor);await dispatchSubmittedOrderPrintJobs(String(session.order_id),business)}
    else await dispatchOrderPrintJobs(String(session.order_id),business,{includeKitchenProduction:false});
  }catch(error){
    // A paid draft stays on the POS online-order alert list until staff send it.
    sent=false;
    console.error(`[voice-payment] order ${session.order_id} was paid but not sent`,error);
  }
  return {approved:true,sent,last4,brand,orderId:String(session.order_id)};
}

export async function abandonVoicePayment(sessionId:string,code="recognition_failed"){
  await ensureVoicePaymentSchema();
  const sql=getSql(),failed=(await sql`UPDATE ordering_voice_payment_sessions SET status='failed',failure_code=CASE WHEN failure_code<>'' THEN failure_code ELSE ${code.slice(0,80)} END,completed_at=NOW(),updated_at=NOW() WHERE id=${sessionId} AND status IN('awaiting_call','collecting') RETURNING call_id`)[0];
  if(failed?.call_id)await sql`UPDATE ordering_call_sessions SET state='ended',handoff_reason=${`Secure payment failed: ${code.slice(0,80)}`},owner_type='none',owner_id='',claimed_by='',claimed_at=NULL,ended_at=COALESCE(ended_at,NOW()),updated_at=NOW() WHERE business=${business} AND three_cx_call_id=${String(failed.call_id)} AND state='handoff_pending'`;
}

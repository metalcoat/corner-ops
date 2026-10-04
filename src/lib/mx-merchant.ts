import { randomInt } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";

export class MxMerchantError extends Error {}
function base(){if(process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production")return"https://api.mxmerchant.com/checkout/v3";
  // Test-only override for a local stand-in of the MX sandbox; ignored in production.
  return process.env.MX_TEST_API_BASE_URL?.trim()||"https://sandbox.api.mxmerchant.com/checkout/v3"}
function credentials(){const merchantId=process.env.MX_MERCHANT_ID?.trim(),key=process.env.MX_CONSUMER_KEY?.trim(),secret=process.env.MX_CONSUMER_SECRET?.trim();if(!merchantId||!key||!secret)throw new MxMerchantError("MX Merchant is not configured.");return{merchantId,authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`}}
async function mxFetch(path:string,init:RequestInit={}){const {authorization}=credentials();const response=await fetch(`${base()}${path}`,{...init,headers:{authorization,accept:"application/json",...init.headers},cache:"no-store",signal:AbortSignal.timeout(12000)});if(!response.ok)throw new MxMerchantError(`MX Merchant request failed (${response.status}).`);return response}
export async function initializeMxPayment(){const {merchantId}=credentials();const response=await mxFetch(`/auth/token/${encodeURIComponent(merchantId)}`,{method:"POST"});const token=await response.json();if(typeof token!=="string"||!token)throw new MxMerchantError("MX Merchant did not issue a payment token.");return{token,merchantId,paymentUrl:`${base()}/payment`}}
export async function retrieveMxPayment(replayId:number){const {merchantId}=credentials();const response=await mxFetch(`/payment?merchantId=${encodeURIComponent(merchantId)}&replayId=${encodeURIComponent(replayId)}`);const data=await response.json() as Record<string,unknown>;if(!String(data.status||"").toLowerCase().includes("approve"))throw new MxMerchantError("MX Merchant did not approve this payment.");return data}
export async function submitMxVoicePayment(input:{amountCents:number;replayId:number;cardNumber:string;expiryMonth:string;expiryYear:string;cvv:string;avsZip:string;avsStreet:string}){
  if(process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production")throw new MxMerchantError("Voice-card testing is locked to the MX sandbox.");
  const {merchantId}=credentials(),initialized=await initializeMxPayment(),response=await fetch(`${initialized.paymentUrl}?token=${encodeURIComponent(initialized.token)}&echo=true`,{
    method:"POST",headers:{"content-type":"application/json",accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(20_000),body:JSON.stringify({merchantId,tenderType:"Card",paymentType:"Sale",amount:input.amountCents/100,replayId:input.replayId,source:"API",cardAccount:{number:input.cardNumber,expiryMonth:input.expiryMonth,expiryYear:input.expiryYear,cvv:input.cvv,avsZip:input.avsZip,avsStreet:input.avsStreet}})
  });
  const data=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||!String(data?.status||"").toLowerCase().includes("approve"))throw new MxMerchantError(String(data?.authMessage||data?.message||"MX declined the sandbox payment."));
  if(!data)throw new MxMerchantError("MX returned an empty sandbox payment response.");
  return data;
}
let schemaPromise:Promise<void>|null=null;
export function ensureMxPaymentSchema(){if(!schemaPromise)schemaPromise=(async()=>{await ensureOrderingAccountSchema();const sql=getSql();await sql`CREATE TABLE IF NOT EXISTS ordering_mx_checkout_sessions(id UUID PRIMARY KEY,business TEXT NOT NULL,order_id UUID NOT NULL REFERENCES ordering_orders(id),check_id UUID,amount_cents INTEGER NOT NULL,replay_id BIGINT NOT NULL UNIQUE,client_mutation_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'initialized',provider_transaction_reference TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`;await sql`CREATE INDEX IF NOT EXISTS ordering_mx_checkout_order_idx ON ordering_mx_checkout_sessions(order_id,created_at DESC)`})();return schemaPromise}
// MX documents replayId as int32. Timestamp concatenation produced a 16-digit
// value that the sandbox rejected before attempting authorization.
export function newReplayId(){return randomInt(1,2_147_483_647)}

// ---- refunds and voids (https://developer.mxmerchant.com/docs/making-a-full-refund-or-void-a-transaction,
// https://developer.mxmerchant.com/docs/making-a-partial-refund) ----
export async function getMxPayment(paymentId:string){const response=await mxFetch(`/payment/${encodeURIComponent(paymentId)}`);return await response.json() as Record<string,unknown>}
const statusOf=(payment:Record<string,unknown>)=>String(payment.status||"").toLowerCase();
/** MX settles card batches nightly; until then a payment can only be voided in full. */
export function mxPaymentSettled(payment:Record<string,unknown>){const status=statusOf(payment);return status.includes("settled")||Boolean(payment.settledDate||payment.settlementDate||payment.batchCloseDate)}
/** Full reversal: MX voids an unsettled payment, or refunds a settled one, then we read back which it did. */
export async function voidOrRefundMxPayment(paymentId:string){
  await mxFetch(`/payment/${encodeURIComponent(paymentId)}?force=true`,{method:"DELETE"});
  const after=await getMxPayment(paymentId),status=statusOf(after);
  if(status.includes("void"))return{kind:"void" as const,payment:after};
  if(status.includes("refund")||status.includes("return")||status.includes("credit"))return{kind:"refund" as const,payment:after};
  throw new MxMerchantError(`MX did not confirm the reversal (payment status: ${after.status||"unknown"}). Check MX Merchant before trying again.`);
}
/** Partial refund on a settled payment: a negative sale on the same card token, linked to the original. */
export async function refundMxPaymentPartially(input:{paymentId:string;amountCents:number;replayId:number}){
  const original=await getMxPayment(input.paymentId);
  if(!mxPaymentSettled(original))throw new MxMerchantError("MX can only refund part of a card charge after tonight's batch settles. Refund the full charge now, or do the partial refund tomorrow.");
  const paymentToken=String(original.paymentToken||"");
  if(!paymentToken)throw new MxMerchantError("MX did not return a card token for the original payment, so it cannot be partially refunded from the POS. Refund it in MX Merchant.");
  const {merchantId}=credentials();
  const response=await fetch(`${base()}/payment?echo=true`,{method:"POST",headers:{authorization:credentials().authorization,accept:"application/json","content-type":"application/json"},cache:"no-store",signal:AbortSignal.timeout(20_000),
    body:JSON.stringify({merchantId,tenderType:"Card",amount:(-input.amountCents/100).toFixed(2),paymentToken,replayId:input.replayId,source:"API"})});
  const data=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||!data||!statusOf(data).includes("approve"))throw new MxMerchantError(String(data?.authMessage||data?.message||`MX declined the refund (${response.status}).`));
  return{kind:"refund" as const,payment:data};
}

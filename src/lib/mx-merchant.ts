import { getSql } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";

export class MxMerchantError extends Error {}
function base(){return process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production"?"https://api.mxmerchant.com/checkout/v3":"https://sandbox.api.mxmerchant.com/checkout/v3"}
function credentials(){const merchantId=process.env.MX_MERCHANT_ID?.trim(),key=process.env.MX_CONSUMER_KEY?.trim(),secret=process.env.MX_CONSUMER_SECRET?.trim();if(!merchantId||!key||!secret)throw new MxMerchantError("MX Merchant is not configured.");return{merchantId,authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`}}
async function mxFetch(path:string,init:RequestInit={}){const {authorization}=credentials();const response=await fetch(`${base()}${path}`,{...init,headers:{authorization,accept:"application/json",...init.headers},cache:"no-store",signal:AbortSignal.timeout(12000)});if(!response.ok)throw new MxMerchantError(`MX Merchant request failed (${response.status}).`);return response}
export async function initializeMxPayment(){const {merchantId}=credentials();const response=await mxFetch(`/auth/token/${encodeURIComponent(merchantId)}`,{method:"POST"});const token=await response.json();if(typeof token!=="string"||!token)throw new MxMerchantError("MX Merchant did not issue a payment token.");return{token,merchantId,paymentUrl:`${base()}/payment`}}
export async function retrieveMxPayment(replayId:number){const {merchantId}=credentials();const response=await mxFetch(`/payment?merchantId=${encodeURIComponent(merchantId)}&replayId=${encodeURIComponent(replayId)}`);const data=await response.json() as Record<string,unknown>;if(!String(data.status||"").toLowerCase().includes("approve"))throw new MxMerchantError("MX Merchant did not approve this payment.");return data}
export async function submitMxVoicePayment(input:{amountCents:number;replayId:number;cardNumber:string;expiryMonth:string;expiryYear:string;cvv:string;avsZip:string}){
  if(process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production")throw new MxMerchantError("Voice-card testing is locked to the MX sandbox.");
  const {merchantId}=credentials(),initialized=await initializeMxPayment(),response=await fetch(`${initialized.paymentUrl}?token=${encodeURIComponent(initialized.token)}&echo=true`,{
    method:"POST",headers:{"content-type":"application/json",accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(20_000),body:JSON.stringify({merchantId,tenderType:"Card",paymentType:"Sale",amount:input.amountCents/100,replayId:input.replayId,source:"API",cardAccount:{number:input.cardNumber,expiryMonth:input.expiryMonth,expiryYear:input.expiryYear,cvv:input.cvv,avsZip:input.avsZip}})
  });
  const data=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||!String(data?.status||"").toLowerCase().includes("approve"))throw new MxMerchantError(String(data?.authMessage||data?.message||"MX declined the sandbox payment."));
  if(!data)throw new MxMerchantError("MX returned an empty sandbox payment response.");
  return data;
}
let schemaPromise:Promise<void>|null=null;
export function ensureMxPaymentSchema(){if(!schemaPromise)schemaPromise=(async()=>{await ensureOrderingAccountSchema();const sql=getSql();await sql`CREATE TABLE IF NOT EXISTS ordering_mx_checkout_sessions(id UUID PRIMARY KEY,business TEXT NOT NULL,order_id UUID NOT NULL REFERENCES ordering_orders(id),check_id UUID,amount_cents INTEGER NOT NULL,replay_id BIGINT NOT NULL UNIQUE,client_mutation_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'initialized',provider_transaction_reference TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`;await sql`CREATE INDEX IF NOT EXISTS ordering_mx_checkout_order_idx ON ordering_mx_checkout_sessions(order_id,created_at DESC)`})();return schemaPromise}
export function newReplayId(){return Number(`${Date.now()}${Math.floor(Math.random()*1000).toString().padStart(3,"0")}`)}

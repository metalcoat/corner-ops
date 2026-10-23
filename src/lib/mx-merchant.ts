import { mxPresentment } from "@/lib/mx-presentment";
import { randomInt } from "node:crypto";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";

export class MxMerchantError extends Error {}
/** MX's answer never arrived (timeout, dropped connection, gateway error): the request may or may not have taken effect. */
export class MxMerchantUnreachableError extends MxMerchantError {}
function base(){if(process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production")return"https://api.mxmerchant.com/checkout/v3";
  // Test-only override for a local stand-in of the MX sandbox; ignored in production.
  return process.env.MX_TEST_API_BASE_URL?.trim()||"https://sandbox.api.mxmerchant.com/checkout/v3"}
function credentials(){const merchantId=process.env.MX_MERCHANT_ID?.trim(),key=process.env.MX_CONSUMER_KEY?.trim(),secret=process.env.MX_CONSUMER_SECRET?.trim();if(!merchantId||!key||!secret)throw new MxMerchantError("MX Merchant is not configured.");return{merchantId,authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`}}
async function mxFetch(path:string,init:RequestInit={}){const {authorization}=credentials();const response=await fetch(`${base()}${path}`,{...init,headers:{authorization,accept:"application/json",...init.headers},cache:"no-store",signal:AbortSignal.timeout(12000)});if(!response.ok)throw new MxMerchantError(`MX Merchant request failed (${response.status}).`);return response}
export async function initializeMxPayment(){const {merchantId}=credentials();const response=await mxFetch(`/auth/token/${encodeURIComponent(merchantId)}`,{method:"POST"});const token=await response.json();if(typeof token!=="string"||!token)throw new MxMerchantError("MX Merchant did not issue a payment token.");return{token,merchantId,paymentUrl:`${base()}/payment`}}
export async function retrieveMxPayment(replayId:number){const {merchantId}=credentials();const response=await mxFetch(`/payment?merchantId=${encodeURIComponent(merchantId)}&replayId=${encodeURIComponent(replayId)}`);const data=await response.json() as Record<string,unknown>;if(!String(data.status||"").toLowerCase().includes("approve"))throw new MxMerchantError("MX Merchant did not approve this payment.");return data}
/** The payment MX holds for a replayId, or null when MX has none (it answers 404). Unlike retrieveMxPayment, any status is returned. */
export async function findMxPaymentByReplayId(replayId:number){const {merchantId,authorization}=credentials();const response=await fetch(`${base()}/payment?merchantId=${encodeURIComponent(merchantId)}&replayId=${encodeURIComponent(replayId)}`,{headers:{authorization,accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(12000)});if(response.status===404)return null;if(!response.ok)throw new MxMerchantError(`MX Merchant payment lookup failed (${response.status}).`);const text=await response.text();if(!text.trim())return null;const data=JSON.parse(text) as Record<string,unknown>;const records=Array.isArray(data.records)?data.records as Record<string,unknown>[]:null;return records?records[0]||null:data}
/**
 * Captures an authorization with the final amount, tip included (https://developer.mxmerchant.com/docs/making-an-adjustment):
 * a sale (paymentType "Sale") on the authorization's card token and auth code with authOnly false. The replayId makes a retry safe to look up.
 */
export async function completeMxAuthorization(input:{paymentToken:string;authCode:string;amountCents:number;tipCents:number;replayId:number}){
  const {merchantId,authorization}=credentials();let response:Response;
  try{response=await fetch(`${base()}/payment?echo=true`,{method:"POST",headers:{authorization,accept:"application/json","content-type":"application/json"},cache:"no-store",signal:AbortSignal.timeout(20_000),
    body:JSON.stringify({merchantId,tenderType:"Card",paymentType:"Sale",amount:(input.amountCents/100).toFixed(2),tip:(input.tipCents/100).toFixed(2),paymentToken:input.paymentToken,authCode:input.authCode,authOnly:false,replayId:input.replayId,source:"API"})})}
  catch(error){throw new MxMerchantUnreachableError(error instanceof Error&&error.name==="TimeoutError"?"MX did not answer in time.":"Could not reach MX.")}
  if([502,503,504].includes(response.status))throw new MxMerchantUnreachableError(`MX is not responding (${response.status}).`);
  const data=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||!data||!String(data.status||"").toLowerCase().includes("approve"))throw new MxMerchantError(String(data?.authMessage||data?.message||`MX declined the final card amount (${response.status}).`));
  return data;
}
export async function submitMxVoicePayment(input:{amountCents:number;replayId:number;cardNumber:string;expiryMonth:string;expiryYear:string;cvv:string;avsZip:string;avsStreet:string}){
  if(process.env.MX_ENVIRONMENT?.trim().toLowerCase()==="production")throw new MxMerchantError("Voice-card testing is locked to the MX sandbox.");
  const {merchantId}=credentials(),initialized=await initializeMxPayment(),response=await fetch(`${initialized.paymentUrl}?token=${encodeURIComponent(initialized.token)}&echo=true`,{
    method:"POST",headers:{"content-type":"application/json",accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(20_000),body:JSON.stringify({merchantId,tenderType:"Card",paymentType:"Sale",amount:input.amountCents/100,replayId:input.replayId,source:"API",...mxPresentment("phone"),cardAccount:{number:input.cardNumber,expiryMonth:input.expiryMonth,expiryYear:input.expiryYear,cvv:input.cvv,avsZip:input.avsZip,avsStreet:input.avsStreet}})
  });
  const data=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||!String(data?.status||"").toLowerCase().includes("approve"))throw new MxMerchantError(String(data?.authMessage||data?.message||"MX declined the sandbox payment."));
  if(!data)throw new MxMerchantError("MX returned an empty sandbox payment response.");
  return data;
}
let schemaPromise:Promise<void>|null=null;
export function ensureMxPaymentSchema(){if(!schemaPromise)schemaPromise=(async()=>{await ensureOrderingAccountSchema();})();return schemaPromise}
// MX documents replayId as int32. Timestamp concatenation produced a 16-digit
// value that the sandbox rejected before attempting authorization.
export function newReplayId(){return randomInt(1,2_147_483_647)}

// ---- refunds and voids (https://developer.mxmerchant.com/docs/making-a-full-refund-or-void-a-transaction,
// https://developer.mxmerchant.com/docs/making-a-partial-refund) ----
export async function getMxPayment(paymentId:string){const response=await mxFetch(`/payment/${encodeURIComponent(paymentId)}`);return await response.json() as Record<string,unknown>}
const statusOf=(payment:Record<string,unknown>)=>String(payment.status||"").toLowerCase();
/**
 * Full reversal: MX voids an unsettled payment, or refunds a settled one, then we read back which it did.
 * For a settled payment MX answers 204 either way and books the refund as a separate "Return" transaction:
 * the original stays "Settled" with refundedAmount/balance updated (seen in the MX sandbox, Oct 2026). A
 * declined refund (e.g. "Rapid Refund Activity Detected") leaves the original unchanged and a declined Return.
 */
export async function voidOrRefundMxPayment(paymentId:string){
  const before=await getMxPayment(paymentId),startedAt=Date.now();
  await mxFetch(`/payment/${encodeURIComponent(paymentId)}?force=true`,{method:"DELETE"});
  const after=await getMxPayment(paymentId),status=statusOf(after);
  if(status.includes("void"))return{kind:"void" as const,payment:after};
  if(status.includes("refund")||status.includes("return")||status.includes("credit"))return{kind:"refund" as const,payment:after};
  const refunded=(payment:Record<string,unknown>)=>Math.abs(Number(payment.refundedAmount||0));
  const refundReturn=await findMxReturn(after,startedAt);
  if(refunded(after)>refunded(before)+0.004)return{kind:"refund" as const,payment:refundReturn&&statusOf(refundReturn).includes("approve")?refundReturn:after};
  if(refundReturn&&!statusOf(refundReturn).includes("approve"))throw new MxMerchantError(`MX declined the refund: ${String(refundReturn.authMessage||refundReturn.status||"no reason given")}.`);
  throw new MxMerchantError(`MX did not confirm the reversal (payment status: ${after.status||"unknown"}). Check MX Merchant before trying again.`);
}
/** The Return MX booked for a refund of this payment just now (same card, amount at most the original's). */
async function findMxReturn(original:Record<string,unknown>,sinceMs:number){
  const {merchantId}=credentials();
  const response=await mxFetch(`/payment?merchantId=${encodeURIComponent(merchantId)}&limit=25`);
  const data=await response.json() as Record<string,unknown>;
  const records=(Array.isArray(data.records)?data.records:Array.isArray(data)?data:[]) as Record<string,unknown>[];
  const card=(payment:Record<string,unknown>)=>payment.cardAccount as Record<string,unknown>|undefined;
  const amount=Math.abs(Number(original.amount||0));
  return records.find((payment)=>String(payment.type||"").toLowerCase()==="return"
    &&card(payment)?.last4===card(original)?.last4&&card(payment)?.cardType===card(original)?.cardType
    &&Math.abs(Number(payment.amount||0))<=amount+0.004
    &&new Date(String(payment.created||"")).getTime()>=sinceMs-120_000)??null;
}
/**
 * Partial refund: a negative amount with paymentType "Return" on the same card token, booked by MX as a Return linked to the original.
 * MX approves it before or after the batch settles (sandbox, Oct 2026; its validation guide has refunds made
 * on unsettled payments).
 */
export async function refundMxPaymentPartially(input:{paymentId:string;amountCents:number;replayId:number}){
  const original=await getMxPayment(input.paymentId);
  const paymentToken=String(original.paymentToken||"");
  if(!paymentToken)throw new MxMerchantError("MX did not return a card token for the original payment, so it cannot be partially refunded from the POS. Refund it in MX Merchant.");
  const {merchantId}=credentials();
  const response=await fetch(`${base()}/payment?echo=true`,{method:"POST",headers:{authorization:credentials().authorization,accept:"application/json","content-type":"application/json"},cache:"no-store",signal:AbortSignal.timeout(20_000),
    body:JSON.stringify({merchantId,tenderType:"Card",paymentType:"Return",amount:(-input.amountCents/100).toFixed(2),paymentToken,replayId:input.replayId,source:"API"})});
  const data=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||!data||!statusOf(data).includes("approve"))throw new MxMerchantError(String(data?.authMessage||data?.message||`MX declined the refund (${response.status}).`));
  return{kind:"refund" as const,payment:data};
}

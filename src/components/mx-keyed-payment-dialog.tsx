"use client";

import { useState } from "react";

export type MxPaymentInitialization = {
  token: string;
  paymentUrl: string;
  merchantId: string;
  amount: number;
  replayId: number;
  customerName?: string;
  avsStreet?: string;
  avsZip?: string;
};

export default function MxKeyedPaymentDialog({payment,onApproved,onCancel}:{
  payment:MxPaymentInitialization;
  onApproved:(replayId:number)=>Promise<void>;
  onCancel:()=>void;
}) {
  const [number,setNumber]=useState("");
  const [expiry,setExpiry]=useState("");
  const [cvv,setCvv]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try {
      const digits=number.replace(/\D/g,"");
      const match=expiry.match(/^\s*(\d{1,2})\s*[/\-]\s*(\d{2}|\d{4})\s*$/);
      if(digits.length<13||digits.length>19||!match||cvv.replace(/\D/g,"").length<3) throw new Error("Enter a valid card number, expiration, and security code.");
      const year=match[2].length===2?`20${match[2]}`:match[2];
      const response=await fetch(`${payment.paymentUrl}?token=${encodeURIComponent(payment.token)}&echo=true`,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
          merchantId:payment.merchantId,tenderType:"Card",paymentType:"Sale",amount:payment.amount,
          replayId:payment.replayId,source:"API",customerName:payment.customerName,
          cardAccount:{number:digits,expiryMonth:match[1].padStart(2,"0"),expiryYear:year,cvv:cvv.replace(/\D/g,""),...(payment.avsStreet?{avsStreet:payment.avsStreet}:{}),...(payment.avsZip?{avsZip:payment.avsZip}:{})},
        }),
      });
      const result=await response.json().catch(()=>null) as {status?:string;message?:string;authMessage?:string}|null;
      if(!response.ok||!String(result?.status||"").toLowerCase().includes("approve")) throw new Error(result?.authMessage||result?.message||"MX declined the payment.");
      setNumber("");setExpiry("");setCvv("");
      await onApproved(payment.replayId);
    } catch(cause){setError(cause instanceof Error?cause.message:"Payment could not be completed.");setBusy(false)}
  }
  return <div className="mxPaymentBackdrop" role="presentation"><form className="mxPaymentDialog" role="dialog" aria-modal="true" aria-labelledby="mx-payment-title" onSubmit={submit}>
    <h2 id="mx-payment-title">Secure card payment</h2><strong>${payment.amount.toFixed(2)}</strong>
    <label>Card number<input autoFocus inputMode="numeric" autoComplete="cc-number" value={number} onChange={e=>setNumber(e.target.value)} placeholder="4242 4242 4242 4242"/></label>
    <div><label>Expiration<input inputMode="numeric" autoComplete="cc-exp" value={expiry} onChange={e=>setExpiry(e.target.value)} placeholder="MM/YY"/></label><label>Security code<input inputMode="numeric" autoComplete="cc-csc" value={cvv} onChange={e=>setCvv(e.target.value)} placeholder="CVV"/></label></div>
    <small>Card details are sent directly to MX Merchant and never pass through Corner Deli servers.</small>
    {error&&<p role="alert">{error}</p>}<footer><button type="button" onClick={onCancel} disabled={busy}>CANCEL</button><button disabled={busy}>{busy?"PROCESSING…":"PAY"}</button></footer>
  </form></div>;
}

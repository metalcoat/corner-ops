"use client";
import { useEffect, useState } from "react";
import "../pos.css";

export default function PosNetworkAccess() {
  const [ip,setIp]=useState(""),[note,setNote]=useState(""),[message,setMessage]=useState("Checking this network…"),[busy,setBusy]=useState(false);
  async function check(){const response=await fetch("/api/pos/access/status",{cache:"no-store"}),body=await response.json();setIp(body.ip||"");if(body.allowed){location.replace("/api/pos/access/status?enter=1");return}setMessage("This network is not approved for POS access.")}
  useEffect(()=>{void check()},[]);
  async function requestAccess(){setBusy(true);const response=await fetch("/api/pos/access/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({note})}),body=await response.json();setMessage(response.ok?"Request sent. Refresh after the owner approves the email.":body.error||"Request failed.");setBusy(false)}
  return <main className="posDevHome"><section className="posDevHomeCard"><p className="posDevEyebrow">Corner Deli POS security</p><h1>Network approval required</h1><p>{message}</p>{ip&&<p><strong>Current IP:</strong> {ip}</p>}<label>Device or location name<input value={note} onChange={event=>setNote(event.target.value)} placeholder="Front register, home office, etc."/></label><div className="posDevChoices"><button disabled={busy} onClick={()=>void requestAccess()}>{busy?"Sending…":"Request access"}</button><button disabled={busy} onClick={()=>void check()}>I’ve been approved — refresh</button></div><p>After network approval, employees must still enter their individual PIN.</p></section></main>
}

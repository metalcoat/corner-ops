"use client";

import { useEffect,useState } from "react";

type Settings={enabled:boolean;mode:"shadow"|"assisted"|"autonomous";model:string;maxResponseWords:number;maxUpsells:number;vadEagerness:"low"|"medium"|"high";recordingEnabled:boolean;transcriptRetentionDays:number};
type Payload={settings:Settings;businessState:{pickupWait:string;deliveryWait:string;pickupAvailable:boolean;deliveryAvailable:boolean};readiness:{ready:boolean}};

export default function AiPhoneSettingsClient(){
  const[data,setData]=useState<Payload|null>(null),[draft,setDraft]=useState<Settings|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>{let active=true;fetch("/api/ordering/settings/ai-phone",{cache:"no-store"}).then(async response=>{const body=await response.json() as Payload;if(active&&response.ok){setData(body);setDraft(body.settings)}}).catch(()=>{if(active)setMessage("AI phone settings are unavailable.")});return()=>{active=false}},[]);
  async function save(){if(!draft)return;setBusy(true);setMessage("");try{const response=await fetch("/api/ordering/settings/ai-phone",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(draft)}),body=await response.json();if(!response.ok)throw new Error(body.error||"Could not save settings.");setDraft(body.settings);setData(current=>current?{...current,settings:body.settings}:current);setMessage("AI phone settings saved.")}catch(error){setMessage(error instanceof Error?error.message:"Could not save settings.")}finally{setBusy(false)}}
  if(!draft)return <section className="posSettingsCard"><h2>AI phone ordering</h2><p role={message?"alert":undefined}>{message||"Loading…"}</p></section>;
  return <section className="posSettingsCard">
    <h2>AI phone ordering</h2>
    <p><strong>{data?.readiness.ready?"READY":"NOT READY"}</strong> · Pickup: {data?.businessState.pickupAvailable?data.businessState.pickupWait:"unavailable"} · Delivery: {data?.businessState.deliveryAvailable?data.businessState.deliveryWait:"unavailable"}</p>
    <label><span>Answer calls</span><input type="checkbox" checked={draft.enabled} onChange={event=>setDraft({...draft,enabled:event.target.checked})}/></label>
    <label><span>Operating mode</span><select value={draft.mode} onChange={event=>setDraft({...draft,mode:event.target.value as Settings["mode"]})}><option value="shadow">Shadow — never submit</option><option value="assisted">Assisted — staff review</option><option value="autonomous">Autonomous — submit after confirmation</option></select></label>
    <label><span>Realtime model</span><input value={draft.model} onChange={event=>setDraft({...draft,model:event.target.value})}/></label>
    <label><span>Maximum response words</span><input type="number" min="2" max="30" value={draft.maxResponseWords} onChange={event=>setDraft({...draft,maxResponseWords:Number(event.target.value)})}/></label>
    <label><span>Maximum upsells per order</span><input type="number" min="0" max="3" value={draft.maxUpsells} onChange={event=>setDraft({...draft,maxUpsells:Number(event.target.value)})}/></label>
    <label><span>Turn detection</span><select value={draft.vadEagerness} onChange={event=>setDraft({...draft,vadEagerness:event.target.value as Settings["vadEagerness"]})}><option value="high">Fast</option><option value="medium">Balanced</option><option value="low">Patient</option></select></label>
    <label><span>Transcript retention days</span><input type="number" min="1" max="365" value={draft.transcriptRetentionDays} onChange={event=>setDraft({...draft,transcriptRetentionDays:Number(event.target.value)})}/></label>
    <label><span>Call recording</span><input type="checkbox" checked={draft.recordingEnabled} onChange={event=>setDraft({...draft,recordingEnabled:event.target.checked})}/></label>
    <p><strong>Safety:</strong> recording remains off by default. Shadow mode is the required starting point for real-call evaluation.</p>
    <button disabled={busy} onClick={()=>void save()}>{busy?"SAVING…":"SAVE AI PHONE SETTINGS"}</button>
    {message?<p role="status">{message}</p>:null}
  </section>;
}

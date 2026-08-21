import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getSql } from "@/lib/db";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";

const sockets=new Map<string,WebSocket>();

async function event(callId:string,eventKey:string,eventType:string,role:string,label:string,detail="",durationMs?:number){
  await ensureOrderingAiSchema();
  await getSql()`INSERT INTO ordering_ai_call_events(id,business,call_id,event_key,event_type,role,label,detail,duration_ms)VALUES(${randomUUID()},'Corner Deli',${callId},${eventKey},${eventType},${role},${label.slice(0,160)},${detail.slice(0,2000)},${durationMs??null})ON CONFLICT(business,event_key)DO NOTHING`;
}
async function transcript(callId:string,eventKey:string,speaker:"customer"|"assistant"|"system",text:string,metadata:Record<string,unknown>={}){
  const value=text.trim();if(!value)return;
  await ensureOrderingAiSchema();
  await getSql()`INSERT INTO ordering_call_transcript_segments(id,business,call_id,event_key,speaker,transcript,metadata)VALUES(${randomUUID()},'Corner Deli',${callId},${eventKey},${speaker},${value.slice(0,5000)},${JSON.stringify(metadata)}::jsonb)ON CONFLICT(business,event_key)DO NOTHING`;
}
async function latency(callId:string,turnId:string,metric:string,durationMs:number,model:string){
  await ensureOrderingAiSchema();
  await getSql()`INSERT INTO ordering_ai_latency_samples(id,business,call_id,turn_id,metric,duration_ms,model)VALUES(${randomUUID()},'Corner Deli',${callId},${turnId},${metric},${Math.max(0,Math.round(durationMs))},${model})`;
}
const text=(value:unknown)=>typeof value==="string"?value.trim():"";

export function startOpenAiSideband(callId:string,greeting:string,model:string){
  const apiKey=process.env.OPENAI_API_KEY||"";if(!apiKey)throw new Error("OpenAI API key is not configured.");
  sockets.get(callId)?.terminate();
  const socket=new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,{headers:{Authorization:`Bearer ${apiKey}`}});
  sockets.set(callId,socket);
  const openedAt=Date.now(),hardStop=setTimeout(()=>socket.close(),4*60*60*1000),firstAudio=new Set<string>();
  let ping:ReturnType<typeof setInterval>|undefined,lastSpeechStoppedAt=0,lastTurnId="",responseActive=false;
  socket.once("open",()=>{
    void event(callId,`${callId}:sideband-open`,"sideband.connected","system","Realtime connection active");
    ping=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.ping()},20_000);
    socket.send(JSON.stringify({type:"response.create",response:{instructions:`Say exactly: \"${greeting}\" Use upbeat, natural deli-counter energy.`,output_modalities:["audio"],max_output_tokens:50}}));
  });
  socket.on("message",data=>{try{
    const row=JSON.parse(String(data)) as Record<string,any>,type=String(row.type||""),eventId=String(row.event_id||`${type}:${Date.now()}`),key=`${callId}:${eventId}`;
    if(type==="input_audio_buffer.speech_started"){
      if(responseActive)void event(callId,key,"conversation.barge_in","system","Caller interrupted — AI speech stopped");
      void event(callId,key,type,"customer","Customer speaking");
    }else if(type==="input_audio_buffer.speech_stopped"){
      lastSpeechStoppedAt=Date.now();lastTurnId=eventId;void event(callId,key,type,"system","Processing customer request");
    }else if(type==="conversation.item.input_audio_transcription.completed"){
      const value=text(row.transcript);void transcript(callId,key,"customer",value,{languages:row.languages||[]});void event(callId,key,type,"customer","Customer",value);
    }else if(type==="response.created"){
      responseActive=true;if(lastSpeechStoppedAt)void latency(callId,lastTurnId,"model_response_start",Date.now()-lastSpeechStoppedAt,model);
    }else if(type==="response.output_audio.delta"){
      const responseId=String(row.response_id||"");if(responseId&&!firstAudio.has(responseId)){firstAudio.add(responseId);const delay=lastSpeechStoppedAt?Date.now()-lastSpeechStoppedAt:0;void latency(callId,lastTurnId,"speech_generation_start",delay,model);void event(callId,key,type,"assistant","AI started speaking","",delay)}
    }else if(type==="response.output_audio_transcript.done"){
      const value=text(row.transcript);void transcript(callId,key,"assistant",value);void event(callId,key,type,"assistant","AI",value);
    }else if(type==="response.output_item.added"&&row.item?.type==="mcp_call")void event(callId,key,type,"tool",`Using ${row.item.name||"ordering tool"}`);
    else if(type==="response.mcp_call.completed")void event(callId,key,type,"tool","Ordering tool completed");
    else if(type==="response.mcp_call.failed")void event(callId,key,type,"error","Ordering tool failed");
    else if(type==="response.done")responseActive=false;
    else if(type==="error"){void event(callId,key,type,"error","Realtime error",text(row.error?.message));console.error("OpenAI realtime sideband error.",{callId,error:row.error?.message||"unknown error"})}
  }catch(error){console.warn("OpenAI realtime sideband event could not be parsed.",{callId,error:error instanceof Error?error.message:"unknown error"})}});
  socket.once("error",error=>{void event(callId,`${callId}:sideband-error:${Date.now()}`,"sideband.error","error","Realtime connection error",error.message)});
  socket.once("close",()=>{clearTimeout(hardStop);if(ping)clearInterval(ping);if(sockets.get(callId)===socket)sockets.delete(callId);void event(callId,`${callId}:sideband-close:${Date.now()}`,"sideband.closed","system","Realtime telemetry disconnected",`Connected ${Date.now()-openedAt} ms`)});
}

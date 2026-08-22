import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getSql } from "@/lib/db";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { AiToolError,auditAiTool,priceSpokenOrder,serviceType,type SpokenOrderItem } from "@/lib/ordering-ai-tools";

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
  let ping:ReturnType<typeof setInterval>|undefined,lastSpeechStoppedAt=0,lastTurnId="",responseActive=false,customerTurnPending=false,toolUsedForTurn=false;
  socket.once("open",()=>{
    void event(callId,`${callId}:sideband-open`,"sideband.connected","system","Realtime connection active");
    ping=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.ping()},20_000);
    socket.send(JSON.stringify({type:"response.create",response:{instructions:`Say exactly: \"${greeting}\" Use upbeat, natural deli-counter energy.`,output_modalities:["audio"],max_output_tokens:50,tool_choice:"none"}}));
  });
  const executePriceOrder=async(row:Record<string,any>)=>{
    const started=Date.now(),requestId=randomUUID(),actor={id:`openai:${callId}`,name:"Corner Deli AI Phone",type:"employee" as const,role:"employee" as const};
    try{
      const args=JSON.parse(String(row.arguments||"{}")) as Record<string,unknown>,sql=getSql();
      const call=(await sql`SELECT id,order_id,caller_phone FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} AND state IN('ai','handoff_pending') LIMIT 1`)[0];
      if(!call)throw new AiToolError("NOT_AUTHORIZED","The active phone call was not found.","Ask the caller to try again.",403);
      const result=await priceSpokenOrder({business:"Corner Deli",actor,service:serviceType(args.serviceType),items:Array.isArray(args.items)?args.items as SpokenOrderItem[]:[],orderId:call.order_id||null,callerPhone:String(call.caller_phone||""),firstName:String(args.firstName||""),lastName:String(args.lastName||"")});
      await sql`UPDATE ordering_call_sessions SET order_id=${String(result.id)},updated_at=NOW() WHERE id=${call.id}`;
      await auditAiTool({business:"Corner Deli",requestId,conversationId:callId,tool:"price_order",actor,orderId:String(result.id),outcome:"success",inputSummary:{keys:Object.keys(args),source:"realtime_function"},resultSummary:{lineCount:result.lines.length,totalCents:result.total_cents},durationMs:Date.now()-started,model});
      socket.send(JSON.stringify({type:"conversation.item.create",item:{type:"function_call_output",call_id:row.call_id,output:JSON.stringify(result)}}));
    }catch(error){
      const known=error instanceof AiToolError?error:new AiToolError("INTERNAL_ERROR","Pricing failed.","Ask one precise clarification, then retry.",500);
      await auditAiTool({business:"Corner Deli",requestId,conversationId:callId,tool:"price_order",actor,outcome:"error",errorCode:known.code,inputSummary:{source:"realtime_function"},resultSummary:{message:known.message},durationMs:Date.now()-started,model});
      socket.send(JSON.stringify({type:"conversation.item.create",item:{type:"function_call_output",call_id:row.call_id,output:JSON.stringify({error:{code:known.code,message:known.message,remedy:known.remedy}})}}));
    }
    socket.send(JSON.stringify({type:"response.create",response:{output_modalities:["audio"],tool_choice:"auto"}}));
  };
  socket.on("message",data=>{try{
    const row=JSON.parse(String(data)) as Record<string,any>,type=String(row.type||""),eventId=String(row.event_id||`${type}:${Date.now()}`),key=`${callId}:${eventId}`;
    if(type==="input_audio_buffer.speech_started"){
      if(responseActive)void event(callId,key,"conversation.barge_in","system","Caller interrupted — AI speech stopped");
      void event(callId,key,type,"customer","Customer speaking");
    }else if(type==="input_audio_buffer.speech_stopped"){
      lastSpeechStoppedAt=Date.now();lastTurnId=eventId;customerTurnPending=true;toolUsedForTurn=false;void event(callId,key,type,"system","Processing customer request");
    }else if(type==="conversation.item.input_audio_transcription.completed"){
      const value=text(row.transcript);void transcript(callId,key,"customer",value,{languages:row.languages||[]});void event(callId,key,type,"customer","Customer",value);
    }else if(type==="response.created"){
      responseActive=true;if(lastSpeechStoppedAt)void latency(callId,lastTurnId,"model_response_start",Date.now()-lastSpeechStoppedAt,model);
    }else if(type==="response.output_audio.delta"){
      const responseId=String(row.response_id||"");if(responseId&&!firstAudio.has(responseId)){firstAudio.add(responseId);const delay=lastSpeechStoppedAt?Date.now()-lastSpeechStoppedAt:0;void latency(callId,lastTurnId,"speech_generation_start",delay,model);void event(callId,key,type,"assistant","AI started speaking","",delay)}
    }else if(type==="response.output_audio_transcript.done"){
      const value=text(row.transcript);void transcript(callId,key,"assistant",value);void event(callId,key,type,"assistant","AI",value);
      if(customerTurnPending&&!toolUsedForTurn)void event(callId,`${key}:missing-tool`,"ordering.turn_without_tool","error","No ordering tool used after customer turn",value);
      customerTurnPending=false;
    }else if(type==="response.output_item.added"&&(row.item?.type==="mcp_call"||row.item?.type==="function_call")){toolUsedForTurn=true;void event(callId,key,type,"tool",`Using ${row.item.name||"ordering tool"}`)}
    else if(type==="response.function_call_arguments.done"&&row.name==="price_order"){toolUsedForTurn=true;void executePriceOrder(row)}
    else if(type==="response.mcp_call.completed"){toolUsedForTurn=true;void event(callId,key,type,"tool","Ordering tool completed")}
    else if(type==="response.mcp_call.failed")void event(callId,key,type,"error","Ordering tool failed");
    else if(type==="response.done")responseActive=false;
    else if(type==="error"){void event(callId,key,type,"error","Realtime error",text(row.error?.message));console.error("OpenAI realtime sideband error.",{callId,error:row.error?.message||"unknown error"})}
  }catch(error){console.warn("OpenAI realtime sideband event could not be parsed.",{callId,error:error instanceof Error?error.message:"unknown error"})}});
  socket.once("error",error=>{void event(callId,`${callId}:sideband-error:${Date.now()}`,"sideband.error","error","Realtime connection error",error.message)});
  socket.once("close",()=>{clearTimeout(hardStop);if(ping)clearInterval(ping);if(sockets.get(callId)===socket)sockets.delete(callId);void event(callId,`${callId}:sideband-close:${Date.now()}`,"sideband.closed","system","Realtime telemetry disconnected",`Connected ${Date.now()-openedAt} ms`)});
}

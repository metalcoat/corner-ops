import { randomUUID } from "node:crypto";
import { AI_ORDERING_TOOL_NAMES,executeAiOrderingTool,type AiOrderingToolName } from "@/app/api/ordering/ai/tools/route";
import { getSql } from "@/lib/db";
import { AiToolError,auditAiTool } from "@/lib/ordering-ai-tools";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { mcpAuthorized,OPENAI_PHONE_MODEL } from "@/lib/openai-phone-ordering";

export const runtime="nodejs";
type Rpc={jsonrpc?:string;id?:string|number|null;method?:string;params?:Record<string,unknown>};
const properties={callId:{type:"string",description:"Exact immutable call ID supplied in the phone session instructions."}};
const schemas:Record<AiOrderingToolName,Record<string,unknown>>={
  describe_capabilities:{type:"object",properties,required:["callId"],additionalProperties:false},
  menu_browse:{type:"object",properties:{...properties,scheduledFor:{type:"string"}},required:["callId"],additionalProperties:false},
  menu_search:{type:"object",properties:{...properties,query:{type:"string"},scheduledFor:{type:"string"}},required:["callId","query"],additionalProperties:false},
  ordering_availability:{type:"object",properties:{...properties,serviceType:{type:"string"},at:{type:"string"}},required:["callId","serviceType"],additionalProperties:false},
  future_slots:{type:"object",properties:{...properties,serviceType:{type:"string"},date:{type:"string"}},required:["callId","serviceType","date"],additionalProperties:false},
  promotions:{type:"object",properties,required:["callId"],additionalProperties:false},
  customer_lookup:{type:"object",properties:{...properties,query:{type:"string"}},required:["callId","query"],additionalProperties:false},
  create_draft:{type:"object",properties:{...properties,serviceType:{type:"string"},items:{type:"array",items:{type:"object"}},customerId:{type:"string"},callerPhone:{type:"string"},firstName:{type:"string"},lastName:{type:"string"},scheduledFor:{type:"string"}},required:["callId","serviceType","items"],additionalProperties:false},
  update_draft:{type:"object",properties:{...properties,orderId:{type:"string"},expectedVersion:{type:"integer"},serviceType:{type:"string"},items:{type:"array",items:{type:"object"}},customerId:{type:"string"},callerPhone:{type:"string"},firstName:{type:"string"},lastName:{type:"string"},scheduledFor:{type:"string"}},required:["callId","orderId","expectedVersion","serviceType","items"],additionalProperties:false},
  get_draft:{type:"object",properties:{...properties,orderId:{type:"string"}},required:["callId","orderId"],additionalProperties:false},
  attach_delivery_address:{type:"object",properties:{...properties,orderId:{type:"string"},address:{type:"string"},validationToken:{type:"string"},unit:{type:"string"},customerAddressId:{type:"string"}},required:["callId","orderId","address","validationToken"],additionalProperties:false},
  validate_delivery:{type:"object",properties:{...properties,distanceMiles:{type:"number"},merchandiseSubtotalCents:{type:"integer"}},required:["callId","distanceMiles","merchandiseSubtotalCents"],additionalProperties:false},
  hold:{type:"object",properties:{...properties,orderId:{type:"string"}},required:["callId","orderId"],additionalProperties:false},
  send:{type:"object",properties:{...properties,orderId:{type:"string"},customerConfirmed:{type:"boolean",description:"True only after an explicit spoken yes to the full readback and authoritative total."}},required:["callId","orderId","customerConfirmed"],additionalProperties:false},
};
const descriptions:Record<AiOrderingToolName,string>={describe_capabilities:"Get ordering capabilities and safety rules.",menu_browse:"Browse the current effective menu using stable IDs.",menu_search:"Search current menu items, variants, and modifiers.",ordering_availability:"Check whether ordering is available for a service and time.",future_slots:"List valid future fulfillment slots.",promotions:"List currently active promotion descriptions.",customer_lookup:"Find ordering-safe customer matches by name or phone.",create_draft:"Create a server-priced phone order draft.",update_draft:"Replace a draft using optimistic version control.",get_draft:"Read the authoritative current draft and total.",attach_delivery_address:"Attach a previously validated address and calculate routed delivery pricing.",validate_delivery:"Quote configured distance-based delivery pricing.",hold:"Validate required fields and prepare a full customer readback.",send:"Send a confirmed draft to the kitchen. Requires explicit customer confirmation."};
const tools=AI_ORDERING_TOOL_NAMES.map(name=>({name,description:descriptions[name],inputSchema:schemas[name],annotations:{readOnlyHint:["describe_capabilities","menu_browse","menu_search","ordering_availability","future_slots","promotions","customer_lookup","get_draft","validate_delivery","hold"].includes(name)}}));
const reply=(id:Rpc["id"],result:unknown)=>Response.json({jsonrpc:"2.0",id,result});
const failure=(id:Rpc["id"],code:number,message:string,data?:unknown)=>Response.json({jsonrpc:"2.0",id,error:{code,message,data}});

export async function POST(request:Request){
  if(!mcpAuthorized(request))return Response.json({error:"Unauthorized."},{status:401});
  const rpc=await request.json() as Rpc;
  if(rpc.method==="initialize")return reply(rpc.id,{protocolVersion:"2025-06-18",capabilities:{tools:{listChanged:false}},serverInfo:{name:"corner-ops-ordering",version:"1.0.0"}});
  if(rpc.method==="notifications/initialized")return new Response(null,{status:202});
  if(rpc.method==="tools/list")return reply(rpc.id,{tools});
  if(rpc.method!=="tools/call")return failure(rpc.id,-32601,"Method not found.");
  const name=String(rpc.params?.name||"") as AiOrderingToolName,args={...((rpc.params?.arguments&&typeof rpc.params.arguments==="object"?rpc.params.arguments:{}) as Record<string,unknown>)};
  if(!AI_ORDERING_TOOL_NAMES.includes(name))return failure(rpc.id,-32602,"Unknown ordering tool.");
  const callId=String(args.callId||"");delete args.callId;
  await ensureOrderingAiSchema();
  const call=(await getSql()`SELECT id,state,order_id FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} AND state IN('ai','handoff_pending') LIMIT 1`)[0];
  if(!call)return reply(rpc.id,{content:[{type:"text",text:JSON.stringify({error:{code:"NOT_AUTHORIZED",message:"This tool request is not linked to an active Corner Deli AI call."}})}],isError:true});
  if(name==="send"&&args.customerConfirmed!==true)return reply(rpc.id,{content:[{type:"text",text:JSON.stringify({error:{code:"SEND_BLOCKED",message:"Explicit customer confirmation is required after the complete readback."}})}],isError:true});
  delete args.customerConfirmed;
  const started=Date.now(),requestId=randomUUID(),actor={id:`openai:${callId}`,name:"Corner Deli AI Phone",type:"employee" as const,role:"employee" as const};
  try{const result=await executeAiOrderingTool(name,args,"Corner Deli",actor);const orderId=String(args.orderId||(result&&typeof result==="object"?(result as Record<string,unknown>).id:"")||"");if(orderId)await getSql()`UPDATE ordering_call_sessions SET order_id=${orderId},updated_at=NOW() WHERE id=${call.id}`;await auditAiTool({business:"Corner Deli",requestId,conversationId:callId,tool:name,actor,orderId:orderId||undefined,customerId:args.customerId?String(args.customerId):undefined,outcome:"success",inputSummary:{keys:Object.keys(args),source:"realtime_mcp"},resultSummary:{keys:result&&typeof result==="object"?Object.keys(result):[]},durationMs:Date.now()-started,model:OPENAI_PHONE_MODEL});return reply(rpc.id,{content:[{type:"text",text:JSON.stringify(result)}]})}catch(error){const known=error instanceof AiToolError?error:new AiToolError("INTERNAL_ERROR","The ordering tool could not complete safely.","Retry once, then hand off to an employee.",500);await auditAiTool({business:"Corner Deli",requestId,conversationId:callId,tool:name,actor,orderId:args.orderId?String(args.orderId):undefined,outcome:known.status>=500?"error":"blocked",errorCode:known.code,inputSummary:{keys:Object.keys(args),source:"realtime_mcp"},resultSummary:{message:known.message},durationMs:Date.now()-started,model:OPENAI_PHONE_MODEL});return reply(rpc.id,{content:[{type:"text",text:JSON.stringify({error:{code:known.code,message:known.message,remedy:known.remedy,details:known.details}})}],isError:true})}
}

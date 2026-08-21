import { orderingManagerActor,isAuthorizationResponse } from "@/lib/ordering-route-auth";
import { openAiPhoneReadiness } from "@/lib/openai-phone-ordering";
import { getAiPhoneSettings,realtimeBusinessContext,saveAiPhoneSettings } from "@/lib/ordering-ai-phone-config";

export const runtime="nodejs";

export async function GET(){
  const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;
  const [settings,businessState]=await Promise.all([getAiPhoneSettings(),realtimeBusinessContext()]);
  return Response.json({readiness:openAiPhoneReadiness(),settings,businessState,routing:{source:"3CX deli queue",destination:"OpenAI project SIP endpoint",webhookPath:"/api/openai/realtime/webhook",mcpPath:"/api/openai/ordering/mcp"}});
}

export async function PUT(request:Request){
  const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;
  try{const body=await request.json();return Response.json({settings:await saveAiPhoneSettings({enabled:body.enabled,mode:body.mode,model:body.model,maxResponseWords:Number(body.maxResponseWords),maxUpsells:Number(body.maxUpsells),vadEagerness:body.vadEagerness,recordingEnabled:Boolean(body.recordingEnabled),transcriptRetentionDays:Number(body.transcriptRetentionDays)},actor.id)})}
  catch(error){return Response.json({error:error instanceof Error?error.message:"Could not save AI phone settings."},{status:400})}
}

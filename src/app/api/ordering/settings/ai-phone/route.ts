import { orderingManagerActor,isAuthorizationResponse } from "@/lib/ordering-route-auth";
import { openAiPhoneReadiness } from "@/lib/openai-phone-ordering";
export const runtime="nodejs";
export async function GET(){const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;return Response.json({readiness:openAiPhoneReadiness(),routing:{source:"3CX deli queue",destination:"OpenAI project SIP endpoint",webhookPath:"/api/openai/realtime/webhook",mcpPath:"/api/openai/ordering/mcp"}})}

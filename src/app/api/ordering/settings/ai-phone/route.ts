import {
  geminiPhoneReadiness,
  testGeminiPhoneConnection,
} from "@/lib/gemini-phone";
import {
  getAiPhoneSettings,
  realtimeBusinessContext,
  saveAiPhoneSettings,
} from "@/lib/ordering-ai-phone-config";
import {
  orderingManagerActor,
  isAuthorizationResponse,
} from "@/lib/ordering-route-auth";
import { openAiPhoneReadiness } from "@/lib/openai-phone-ordering";

export const runtime = "nodejs";

export async function GET() {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  const [settings, businessState] = await Promise.all([
    getAiPhoneSettings(),
    realtimeBusinessContext(),
  ]);
  const providers = {
    openai: openAiPhoneReadiness(),
    gemini: geminiPhoneReadiness(settings.geminiModel),
  };
  return Response.json({
    readiness: {
      ready:
        settings.provider === "gemini"
          ? providers.gemini.ready && providers.gemini.liveBridgeReady
          : providers.openai.ready,
      providers,
    },
    settings,
    businessState,
    routing: {
      source: "3CX deli queue",
      provider: settings.provider,
      openai: {
        destination: "OpenAI project SIP endpoint",
        webhookPath: "/api/openai/realtime/webhook",
      },
      gemini: {
        destination: "Corner Ops Asterisk audio bridge",
        liveBridgeReady: providers.gemini.liveBridgeReady,
      },
    },
  });
}

export async function POST(request: Request) {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const body = (await request.json()) as { action?: string; model?: string };
    if (body.action !== "test-gemini")
      return Response.json({ error: "Unsupported action." }, { status: 400 });
    return Response.json({
      result: await testGeminiPhoneConnection(body.model),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Gemini connection test failed.",
      },
      { status: 502 },
    );
  }
}

export async function PUT(request: Request) {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const body = await request.json();
    if (
      body.provider === "gemini" &&
      !geminiPhoneReadiness(String(body.geminiModel || "")).ready
    )
      throw new Error(
        "Gemini calling cannot be selected until its live audio bridge is ready.",
      );
    return Response.json({
      settings: await saveAiPhoneSettings(
        {
          enabled: body.enabled,
          mode: body.mode,
          provider: body.provider,
          openaiModel: body.openaiModel,
          geminiModel: body.geminiModel,
          maxResponseWords: Number(body.maxResponseWords),
          maxUpsells: Number(body.maxUpsells),
          vadEagerness: body.vadEagerness,
          recordingEnabled: Boolean(body.recordingEnabled),
          transcriptRetentionDays: Number(body.transcriptRetentionDays),
        },
        actor.id,
      ),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not save AI phone settings.",
      },
      { status: 400 },
    );
  }
}

import {
  calledDidFromSipHeaders,
  callerFromSipHeaders,
  lineForDid,
  openAiClient,
  openAiPhoneReadiness,
  OPENAI_HUMAN_HANDOFF_TOOL,
  OPENAI_MENU_SEARCH_TOOL,
  OPENAI_PHONE_GREETING,
  OPENAI_PRICE_ORDER_TOOL,
  OPENAI_VOICE_PAYMENT_TOOL,
  registerOpenAiCall,
  testDidAllowed,
} from "@/lib/openai-phone-ordering";
import {
  getAiPhoneSettings,
  realtimeBusinessContext,
} from "@/lib/ordering-ai-phone-config";
import { buildPhoneInstructions } from "@/lib/openai-phone-prompt";
import { startOpenAiSideband } from "@/lib/openai-phone-sideband";
import { phoneOrderingCustomerContext } from "@/lib/ordering-customers";
import {
  callerFromLivePosFeed,
  claimCallerFromAiIngress,
} from "@/lib/three-cx-live-calls";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const raw = await request.text(),
    client = openAiClient();
  let event;
  try {
    event = await client.webhooks.unwrap(raw, request.headers);
  } catch {
    console.warn("OpenAI realtime webhook rejected: invalid signature.");
    return Response.json(
      { error: "Invalid webhook signature." },
      { status: 401 },
    );
  }
  console.info("OpenAI realtime webhook verified.", { eventType: event.type });
  if (event.type !== "realtime.call.incoming")
    return Response.json({ received: true });
  const readiness = openAiPhoneReadiness(),
    callId = event.data.call_id,
    headers = event.data.sip_headers || [],
    calledDid = calledDidFromSipHeaders(headers);
  if (!readiness.ready || !testDidAllowed(calledDid)) {
    console.warn("OpenAI realtime call rejected by readiness policy.", {
      callId,
      ready: readiness.ready,
      calledDidConfigured: Boolean(calledDid),
    });
    await client.realtime.calls.reject(callId, { status_code: 480 });
    return Response.json({
      received: true,
      accepted: false,
      reason: !readiness.ready
        ? "phone_ordering_not_configured"
        : "did_not_allow_test_ai",
    });
  }
  const lineLabel = lineForDid(calledDid),
    sipCaller = callerFromSipHeaders(headers),
    aiIngressCaller = sipCaller ? "" : await claimCallerFromAiIngress(),
    callerPhone =
      sipCaller || aiIngressCaller || (await callerFromLivePosFeed(lineLabel)),
    [settings, business, customer] = await Promise.all([
      getAiPhoneSettings(),
      realtimeBusinessContext(),
      phoneOrderingCustomerContext("Corner Deli", callerPhone),
    ]),
    model = settings.model;
  console.info("OpenAI caller identity resolved.", {
    callId,
    source: sipCaller
      ? "sip"
      : aiIngressCaller
        ? "ai_ingress"
        : "pos_live_feed",
    found: Boolean(callerPhone),
    lineLabel,
  });
  if (settings.provider !== "openai") {
    await client.realtime.calls.reject(callId, { status_code: 480 });
    return Response.json({
      received: true,
      accepted: false,
      reason: "openai_not_selected",
    });
  }
  if (!settings.enabled) {
    await client.realtime.calls.reject(callId, { status_code: 480 });
    return Response.json({
      received: true,
      accepted: false,
      reason: "ai_phone_disabled",
    });
  }
  await registerOpenAiCall(
    callId,
    callerPhone,
    calledDid,
    lineLabel,
    model,
    settings.mode,
  );
  try {
    const acceptingAt = Date.now();
    console.info("OpenAI realtime call acceptance started.", {
      callId,
      model,
      toolChoice: "auto",
    });
    await client.realtime.calls.accept(callId, {
      type: "realtime",
      model,
      output_modalities: ["audio"],
      max_output_tokens: 512,
      truncation: {
        type: "retention_ratio",
        retention_ratio: 0.5,
        token_limits: { post_instructions: 8000 },
      },
      audio: {
        input: {
          noise_reduction: { type: "far_field" },
          transcription: {
            model: "gpt-transcribe",
            language: "en",
            prompt:
              "Corner Deli menu order. Ogdensburger, Big Boss, jumbo, sheet pizza, pep, mozz sticks, wings, medium, extra crispy, blue cheese, ranch, garlic parm, antipasta.",
          },
          turn_detection: {
            type: "semantic_vad",
            eagerness: settings.vadEagerness,
            create_response: false,
            interrupt_response: false,
          },
        },
        output: { voice: "marin", speed: 1.04 },
      },
      instructions: buildPhoneInstructions({
        callId,
        callerPhone,
        lineLabel,
        settings,
        business,
        customer,
      }),
      tools: [
        OPENAI_PRICE_ORDER_TOOL,
        OPENAI_MENU_SEARCH_TOOL,
        OPENAI_HUMAN_HANDOFF_TOOL,
        OPENAI_VOICE_PAYMENT_TOOL,
      ],
      tool_choice: "auto",
      tracing: {
        workflow_name: "corner-deli-phone-ordering-test",
        group_id: callId,
        metadata: { business: "Corner Deli", line: lineLabel, model },
      },
    });
    console.info("OpenAI realtime call accepted.", {
      callId,
      model,
      durationMs: Date.now() - acceptingAt,
    });
    startOpenAiSideband(callId, OPENAI_PHONE_GREETING, model);
  } catch (error) {
    console.error("OpenAI realtime call acceptance failed.", {
      callId,
      error: error instanceof Error ? error.message : "unknown error",
    });
    throw error;
  }
  return Response.json({
    received: true,
    accepted: true,
    testMode: true,
    line: lineLabel,
    model,
  });
}

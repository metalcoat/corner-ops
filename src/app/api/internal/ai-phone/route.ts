import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { geminiPhoneReadiness } from "@/lib/gemini-phone";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import {
  getAiPhoneSettings,
  realtimeBusinessContext,
} from "@/lib/ordering-ai-phone-config";
import { setAiPaymentDetails, serviceType } from "@/lib/ordering-ai-tools";
import {
  prepareVoicePayment,
  voicePaymentInternalAuthorized,
} from "@/lib/ordering-voice-payment";
import { buildPhoneInstructions } from "@/lib/openai-phone-prompt";
import { phoneOrderingCustomerContext } from "@/lib/ordering-customers";
import { callerFromSipHeaders } from "@/lib/openai-phone-ordering";
import { claimCallerFromAiIngress } from "@/lib/three-cx-live-calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const digits = (value: string) => {
  const normalized = value
    .replace(/\D/g, "")
    .replace(/^1(?=\d{10}$)/, "")
    .slice(-10);
  return normalized.length === 10 ? normalized : "";
};

function authorized(request: Request) {
  return voicePaymentInternalAuthorized(
    request.headers.get("x-voice-payment-secret"),
  );
}

export async function GET(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  await ensureOrderingAiSchema();
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "route";
  const callId = String(url.searchParams.get("callId") || "");
  if (action === "status") {
    const row = (
      await getSql()`SELECT bridge_action FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} LIMIT 1`
    )[0];
    return new Response(String(row?.bridge_action || "complete"));
  }
  if (action === "session") {
    const row = (
      await getSql()`SELECT caller_phone,line_label FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} AND selected_provider='gemini' AND state='ai' LIMIT 1`
    )[0];
    if (!row)
      return Response.json(
        { error: "Gemini call not found." },
        { status: 404 },
      );
    const [settings, business, customer] = await Promise.all([
      getAiPhoneSettings(),
      realtimeBusinessContext(),
      phoneOrderingCustomerContext(
        "Corner Deli",
        String(row.caller_phone || ""),
      ),
    ]);
    return Response.json({
      model: settings.geminiModel,
      greeting:
        "Thanks for calling Corner Deli, is this going to be pickup or delivery?",
      instructions: `${buildPhoneInstructions({
        callId,
        callerPhone: String(row.caller_phone || ""),
        lineLabel: String(row.line_label || "TEST"),
        settings,
        business,
        customer,
      })}\nAfter speaking the exact final closing sentence, call complete_call.`,
    });
  }
  const settings = await getAiPhoneSettings();
  const readiness = geminiPhoneReadiness(settings.geminiModel);
  if (settings.provider !== "gemini" || !settings.enabled || !readiness.ready)
    return new Response("openai|");
  const id = randomUUID();
  const sipCaller = callerFromSipHeaders([
    {
      name: "x-corner-ops-caller",
      value: String(url.searchParams.get("caller") || ""),
    },
  ]);
  const callerPhone = sipCaller || (await claimCallerFromAiIngress());
  const did = digits(String(url.searchParams.get("did") || ""));
  await getSql()`INSERT INTO ordering_call_sessions(id,business,three_cx_call_id,caller_phone,called_did,line_label,selected_model,selected_provider,operating_mode,state,owner_type,owner_id,bridge_action) VALUES(${randomUUID()},'Corner Deli',${id},${callerPhone},${did},'GEMINI TEST',${settings.geminiModel},'gemini',${settings.mode},'ai','ai',${`gemini:${id}`},'') ON CONFLICT(three_cx_call_id) DO UPDATE SET caller_phone=EXCLUDED.caller_phone,called_did=EXCLUDED.called_did,selected_model=EXCLUDED.selected_model,selected_provider='gemini',operating_mode=EXCLUDED.operating_mode,state='ai',owner_type='ai',owner_id=EXCLUDED.owner_id,bridge_action='',updated_at=NOW()`;
  return new Response(`gemini|${id}`);
}

export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    await ensureOrderingAiSchema();
    const body = (await request.json()) as Record<string, unknown>;
    const callId = String(body.callId || "");
    const action = String(body.action || "");
    const call = (
      await getSql()`SELECT call.id,call.order_id,orders.service_type FROM ordering_call_sessions call LEFT JOIN ordering_orders orders ON orders.id=call.order_id WHERE call.business='Corner Deli' AND call.three_cx_call_id=${callId} AND call.selected_provider='gemini' LIMIT 1`
    )[0];
    if (!call)
      return Response.json(
        { error: "Gemini call not found." },
        { status: 404 },
      );
    if (action === "event") {
      const eventType = String(body.eventType || "gemini.voice").slice(0, 120);
      const eventKey = String(
        body.eventKey || `${callId}:${eventType}:${randomUUID()}`,
      ).slice(0, 240);
      const label = String(body.label || eventType).slice(0, 160);
      const detail = JSON.stringify(body.detail || {}).slice(0, 2000);
      await getSql()`INSERT INTO ordering_ai_call_events(id,business,call_id,event_key,event_type,role,label,detail,duration_ms) VALUES(${randomUUID()},'Corner Deli',${callId},${eventKey},${eventType},'system',${label},${detail},${body.durationMs == null ? null : Math.max(0, Number(body.durationMs) || 0)}) ON CONFLICT(business,event_key) DO NOTHING`;
      return Response.json({ ok: true });
    }
    if (action === "handoff") {
      const reason = String(
        body.reason || "Customer requested an employee.",
      ).slice(0, 500);
      if (
        /(?:system|internal|menu|modifier|item|pricing|tool).*(?:error|fail|problem)|(?:error|fail|problem).*(?:add|find|menu|item|modifier|pricing|tool)/i.test(
          reason,
        )
      )
        return Response.json({
          closeBridge: false,
          handoffBlocked: true,
          instruction:
            "This is a recoverable ordering failure. Keep the current cart, ask whether to retry that item or continue, and remain on the call through payment.",
        });
      await getSql()`UPDATE ordering_call_sessions SET state='handoff_pending',bridge_action='handoff',handoff_reason=${String(body.reason || "Customer requested an employee.").slice(0, 500)},updated_at=NOW() WHERE id=${call.id}`;
      return Response.json({ closeBridge: true });
    }
    if (action === "payment") {
      if (!call.order_id)
        throw new Error("A priced order is required before payment.");
      const service = serviceType(call.service_type);
      await setAiPaymentDetails({
        orderId: String(call.order_id),
        business: "Corner Deli",
        service,
        paymentMethod: "card",
        tipCents: Number(body.tipCents || 0),
        actor: {
          id: `gemini:${callId}`,
          name: "Corner Deli Gemini Phone",
          type: "employee",
          role: "employee",
        },
      });
      await prepareVoicePayment(callId);
      await getSql()`UPDATE ordering_call_sessions SET bridge_action='payment',updated_at=NOW() WHERE id=${call.id}`;
      return Response.json({ closeBridge: true });
    }
    if (action === "complete") {
      await getSql()`UPDATE ordering_call_sessions SET state='ended',bridge_action='complete',ended_at=NOW(),updated_at=NOW() WHERE id=${call.id}`;
      return Response.json({ closeBridge: true });
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Action failed." },
      { status: 409 },
    );
  }
}

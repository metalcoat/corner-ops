#!/usr/bin/env node
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main() {
  const [
    { ensureOrderingAiSchema },
    { getSql },
    { ingestThreeCxLiveCall },
    route,
  ] = await Promise.all([
    import("../src/lib/ordering-ai-schema"),
    import("../src/lib/db"),
    import("../src/lib/three-cx-live-calls"),
    import("../src/app/api/internal/ai-phone/route"),
  ]);
  await ensureOrderingAiSchema();
  const sql = getSql();
  const current = (
    await sql`SELECT provider,enabled FROM ordering_ai_phone_settings WHERE business='Corner Deli'`
  )[0];
  let callId = "";
  const cfdCallId = `gemini-cfd-${Date.now()}`;
  const secret =
    process.env.VOICE_PAYMENT_INTERNAL_SECRET ||
    process.env.THREE_CX_CRM_SECRET ||
    "";
  assert.ok(secret);
  process.env.GEMINI_PHONE_BRIDGE_ENABLED = "true";
  try {
    await sql`UPDATE ordering_ai_phone_settings SET provider='gemini',enabled=TRUE WHERE business='Corner Deli'`;
    await ingestThreeCxLiveCall({
      callId: `ai-${cfdCallId}`,
      callerNumber: "3155550187",
      status: "ringing",
      source: "ai_ingress",
    });
    const routed = await route.GET(
      new Request(
        "http://localhost/api/internal/ai-phone?caller=100&did=3156057291",
        { headers: { "x-voice-payment-secret": secret } },
      ),
    );
    const decision = await routed.text();
    assert.match(decision, /^gemini\|[0-9a-f-]{36}\|3155550187$/);
    callId = decision.split("|")[1];
    const routedCall = (
      await sql`SELECT caller_phone FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`
    )[0];
    assert.equal(routedCall.caller_phone, "3155550187");
    const session = await route.GET(
      new Request(
        `http://localhost/api/internal/ai-phone?action=session&callId=${callId}`,
        { headers: { "x-voice-payment-secret": secret } },
      ),
    );
    const sessionBody = await session.json();
    assert.equal(sessionBody.model, "gemini-3.1-flash-live-preview");
    assert.match(sessionBody.instructions, /PRICE_ORDER/);
    await route.POST(
      new Request("http://localhost/api/internal/ai-phone", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voice-payment-secret": secret,
        },
        body: JSON.stringify({ callId, action: "complete" }),
      }),
    );
    const status = await route.GET(
      new Request(
        `http://localhost/api/internal/ai-phone?action=status&callId=${callId}`,
        { headers: { "x-voice-payment-secret": secret } },
      ),
    );
    assert.equal(await status.text(), "complete");
    console.log(
      JSON.stringify({
        status: "passed",
        providerRouting: true,
        cfdCallerIdFallback: true,
        sessionInstructions: true,
        completionRouting: true,
      }),
    );
  } finally {
    if (callId)
      await sql`DELETE FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`;
    await sql`DELETE FROM three_cx_live_calls WHERE call_id=${`ai-${cfdCallId}`}`;
    await sql`UPDATE ordering_ai_phone_settings SET provider=${String(current.provider)},enabled=${Boolean(current.enabled)} WHERE business='Corner Deli'`;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
// A failed card payment on the AI line leaves the call waiting for staff with a reason a cashier can read, and
// the order untouched (dev test call 2026-11-06 ended instead, so the POS popup never showed). Runs inside a
// rolled-back transaction on the dev database. Run: npx tsx scripts/ai-phone-handoff-validate.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:ai-phone-handoff";

async function main() {
  const [{ getSql, withTransaction }, payment, reasons] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ordering-voice-payment"),
    import("../src/lib/ai-handoff-reason"),
  ]);
  const checks: string[] = [];
  const check = (name: string, condition: boolean, detail?: unknown) => {
    checks.push(name);
    assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
  };

  check("payment codes read as plain reasons", reasons.aiHandoffReason("Secure payment failed: card_recognition_failed").startsWith("Card payment failed twice: couldn't understand the card number"));
  check("a decline says nothing was charged", /Nothing was charged/.test(reasons.aiHandoffReason("Secure payment failed: provider_payment_failed")));
  check("an in-progress card payment is not a staff task", reasons.cardPaymentInProgress("Secure sandbox voice payment") && /Nothing to do unless it fails/.test(reasons.aiHandoffReason("Secure sandbox voice payment")));
  check("the AI's own handoff sentence is shown as written", reasons.aiHandoffReason("Caller asked for a manager.") === "Caller asked for a manager.");
  check("a dropped AI session reads plainly", /dropped/.test(reasons.aiHandoffReason("Gemini session ended.")));

  try {
    await withTransaction(async () => {
      const sql = getSql();
      const order = (await sql`SELECT id,total_cents,version FROM ordering_orders WHERE business='Corner Deli' ORDER BY created_at DESC LIMIT 1`)[0];
      assert.ok(order, "needs one order on dev");
      const callId = `handoff-validate-${randomUUID()}`, sessionId = randomUUID();
      await sql`INSERT INTO ordering_call_sessions(id,business,three_cx_call_id,caller_phone,called_did,line_label,selected_model,selected_provider,operating_mode,state,owner_type,owner_id,bridge_action,order_id,handoff_reason) VALUES(${randomUUID()},'Corner Deli',${callId},'3155550142','','TEST','x','gemini','shadow','handoff_pending','none','','payment',${order.id},'Secure sandbox voice payment')`;
      await sql`INSERT INTO ordering_voice_payment_sessions(id,business,call_id,order_id,amount_cents,replay_id,status,expires_at) VALUES(${sessionId},'Corner Deli',${callId},${order.id},${Number(order.total_cents)},${Date.now()},'collecting',NOW()+INTERVAL '10 minutes')`;
      await payment.abandonVoicePayment(sessionId, "card_recognition_failed");
      const call = (await sql`SELECT state,bridge_action,handoff_reason,ended_at,order_id FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`)[0];
      check("failed card payment keeps the call waiting for staff", call.state === "handoff_pending" && call.bridge_action === "handoff" && !call.ended_at, call);
      check("the stored reason is the readable one", String(call.handoff_reason).startsWith("Card payment failed twice"), call.handoff_reason);
      check("the order stays on the call", String(call.order_id) === String(order.id), call);
      const after = (await sql`SELECT version,total_cents FROM ordering_orders WHERE id=${order.id}`)[0];
      check("the order itself is untouched", Number(after.version) === Number(order.version) && Number(after.total_cents) === Number(order.total_cents), after);
      const session = (await sql`SELECT status,failure_code FROM ordering_voice_payment_sessions WHERE id=${sessionId}`)[0];
      check("the payment session is failed with its code", session.status === "failed" && session.failure_code === "card_recognition_failed", session);
      await payment.abandonVoicePayment(sessionId, "provider_payment_failed");
      const again = (await sql`SELECT failure_code FROM ordering_voice_payment_sessions WHERE id=${sessionId}`)[0];
      check("a second abandon changes nothing", again.failure_code === "card_recognition_failed", again);
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify({ status: "passed", checks: checks.length }));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

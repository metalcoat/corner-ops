import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
localValidationEnv();
// All processor traffic is intercepted; never use real card or merchant credentials.
process.env.MX_ENVIRONMENT = "sandbox";
process.env.MX_MERCHANT_ID = "regression";
process.env.MX_CONSUMER_KEY = "regression";
process.env.MX_CONSUMER_SECRET = "regression";

async function main() {
  const [
    { getSql, withTransaction },
    { priceSpokenOrder },
    { chargeVoicePayment },
    { submitDraftOrder },
  ] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ordering-ai-tools"),
    import("../src/lib/ordering-voice-payment"),
    import("../src/lib/ordering-order-lifecycle"),
  ]);
  const actor = {
    id: "ai-payment-safety",
    name: "Payment regression",
    type: "employee" as const,
    role: "owner" as const,
  };
  const originalFetch = globalThis.fetch,
    rollback = "rollback:ai-payment-safety";
  let passed = 0,
    saleAttempts = 0,
    uniqueCharges = 0;
  const approved = new Map<number, string>();
  let mode: "timeout" | "commit_failure" | "success" = "timeout",
    currentOrder = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.match(url, /sandbox\.api\.mxmerchant\.com/);
    if (url.includes("/auth/token/")) return Response.json("regression-token");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    saleAttempts++;
    if (!approved.has(body.replayId)) {
      approved.set(body.replayId, `regression-${randomUUID()}`);
      uniqueCharges++;
    }
    if (mode === "timeout") {
      mode = "success";
      throw new DOMException("Simulated lost processor reply", "TimeoutError");
    }
    if (mode === "commit_failure")
      await getSql()`UPDATE ordering_orders SET status='cancelled' WHERE id=${currentOrder}`;
    return Response.json({
      status: "Approved",
      id: approved.get(body.replayId),
      cardAccount: { cardType: "Visa" },
    });
  };
  try {
    await withTransaction(async () => {
      const sql = getSql();
      await sql`UPDATE ordering_hardware_devices SET active=FALSE WHERE business='Corner Deli'`;
      const make = async (service: "pickup" | "delivery" = "pickup") => {
        const order = await priceSpokenOrder({
          business: "Corner Deli",
          actor,
          service,
          firstName: "Regression",
          callerPhone: "3155550100",
          items: [{ name: "large fries" }],
        });
        const sessionId = randomUUID();
        await sql`INSERT INTO ordering_voice_payment_sessions(id,business,call_id,order_id,caller_phone,amount_cents,replay_id,status,expires_at) VALUES(${sessionId},'Corner Deli',${`regression-${randomUUID()}`},${order.id},'3155550100',${Number(order.total_cents)},${Math.floor(Math.random() * 2000000000) + 1},'collecting',NOW()+INTERVAL '10 minutes')`;
        return { order, sessionId };
      };
      const charge = (sessionId: string) =>
        chargeVoicePayment({
          sessionId,
          cardNumber: "4111111111111111",
          expiryMonth: "12",
          expiryYear: "2030",
          cvv: "123",
          avsZip: "13669",
        });
      const incomplete = await make("delivery"),
        before = saleAttempts;
      await assert.rejects(charge(incomplete.sessionId), /Delivery address/);
      assert.equal(saleAttempts, before);
      passed++;
      const lostReply = await make();
      // Sending first isolates payment retry from hours and kitchen submission rules.
      await submitDraftOrder(lostReply.order.id, "Corner Deli", actor, {
        approved: true,
        reason: "Regression fixture",
      });
      const chargesBefore = uniqueCharges;
      await assert.rejects(charge(lostReply.sessionId));
      await charge(lostReply.sessionId);
      assert.equal(uniqueCharges - chargesBefore, 1);
      assert.equal(saleAttempts - before, 2);
      assert.equal(
        (
          await sql`SELECT COUNT(*)::int count FROM ordering_payment_transactions WHERE order_id=${lostReply.order.id} AND transaction_type='payment'`
        )[0].count,
        1,
      );
      await assert.rejects(charge(lostReply.sessionId));
      assert.equal(saleAttempts - before, 2);
      passed++;
      const failedCommit = await make();
      currentOrder = failedCommit.order.id;
      mode = "commit_failure";
      await assert.rejects(
        charge(failedCommit.sessionId),
        /approved.*employee review/i,
      );
      const recovery = (
        await sql`SELECT status,failure_code,provider_transaction_reference FROM ordering_voice_payment_sessions WHERE id=${failedCommit.sessionId}`
      )[0];
      assert.equal(recovery.status, "approved_unapplied");
      assert.equal(recovery.failure_code, "order_commit_failed");
      assert.ok(recovery.provider_transaction_reference);
      const attempts = saleAttempts;
      await assert.rejects(charge(failedCommit.sessionId));
      assert.equal(saleAttempts, attempts);
      passed++;
      const kitchen = await make();
      await submitDraftOrder(kitchen.order.id, "Corner Deli", actor, {
        approved: true,
        reason: "Regression fixture",
      });
      await submitDraftOrder(kitchen.order.id, "Corner Deli", actor);
      const jobs =
        await sql`SELECT id,payload FROM ordering_print_jobs WHERE order_id=${kitchen.order.id} AND purpose='kitchen_production' AND event_subtype='initial_send'`;
      assert.equal(jobs.length, 1);
      passed++;
      throw new Error(rollback);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== rollback) throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(
    JSON.stringify({
      passed,
      failed: 0,
      incompleteDeliveryBlocked: true,
      lostReplySingleCharge: true,
      approvalCommitFailureRecoverable: true,
      kitchenExactlyOnce: true,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

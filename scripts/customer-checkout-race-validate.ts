// Requires an explicitly supplied disposable test database. All outbound requests
// are intercepted; this script never contacts a payment processor.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

async function main() {
  const database = new URL(process.env.DATABASE_URL || "");
  assert.ok(/test|regression/.test(database.pathname) || (process.env.ORDERING_AUDIT_DATABASE === "1" && process.env.CI === "true"), "Use a disposable test database.");
  assert.equal(process.env.VALIDATION_DISABLE_OUTBOUND, "1");
  Object.assign(process.env, {
    MX_ENVIRONMENT: "sandbox", MX_MERCHANT_ID: "test-merchant",
    MX_CONSUMER_KEY: "test-key", MX_CONSUMER_SECRET: "test-secret",
    MX_TEST_API_BASE_URL: "http://checkout.invalid/checkout/v3",
  });
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { customerSessionCookie, customerSessionHash } = await import("../src/lib/customer-ordering-session");
  const { POST } = await import("../src/app/api/customer/orders/[id]/payments/mx/route");
  const { POST: redeemLoyalty } = await import("../src/app/api/customer/orders/[id]/loyalty/route");
  const { POST: redeemPoints } = await import("../src/app/api/customer/orders/[id]/points/route");
  const { adjustLoyalty, requestLoyaltyRedemption } = await import("../src/lib/ordering-loyalty");
  const { submitZeroBalanceCustomerOrder } = await import("../src/lib/customer-zero-balance-checkout");
  const { POST: createCart } = await import("../src/app/api/customer/cart/route");
  const { POST: payLater } = await import("../src/app/api/customer/orders/[id]/pay-later/route");
  const { ensureOrderingTimingSchema } = await import("../src/lib/ordering-timing-schema");
  const { listWebPaymentsNeedingReview, resolveWebPaymentReview } = await import("../src/lib/customer-payment-review");
  const { listWaitingOnlineOrders } = await import("../src/lib/ordering-online-alerts");
  const { assertOrderCanTakePayment, commitTender } = await import("../src/lib/ordering-payments");
  const { resolveTerminalSaleReview } = await import("../src/lib/mx-terminal-payments");
  await ensureOrderingTimingSchema();
  const sql = getSql();
  const categoryId = randomUUID(), itemId = randomUUID(), sessionId = randomUUID(), checkoutId = randomUUID(), customerId = randomUUID();
  const hash = customerSessionHash(sessionId);
  let orderId = "";
  let zeroOrderId = "";
  const driftOrderIds: string[] = [];
  const programId = randomUUID();
  const fixtureWindows: string[] = [];
  const originalFetch = globalThis.fetch;
  let secondRead!: () => void, firstFinished!: () => void;
  const bothReading = new Promise<void>((resolve) => { secondRead = resolve; });
  const firstCompleted = new Promise<void>((resolve) => { firstFinished = resolve; });
  let reads = 0, voids = 0;
  try {
    // The CI menu fixture has no store hours. Seed only a previously unconfigured
    // disposable database; remove exactly these rows again in cleanup.
    if (!(await sql`SELECT 1 FROM ordering_operating_windows WHERE business='Corner Deli' LIMIT 1`)[0]) {
      for (let weekday = 0; weekday < 7; weekday++) {
        const id = randomUUID(); fixtureWindows.push(id);
        await sql`INSERT INTO ordering_operating_windows(id,business,service_type,weekday,opens_at,closes_at,updated_by)
          VALUES(${id},'Corner Deli','all',${weekday},'00:00','23:59','checkout-regression')`;
      }
    }
    await sql`INSERT INTO ordering_menu_categories(id,business,name) VALUES(${categoryId},'Corner Deli',${`Checkout race validation ${categoryId}`})`;
    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) VALUES(${itemId},'Corner Deli',${categoryId},'Checkout race validation',1000)`;
    await sql`INSERT INTO ordering_customers(id,business,display_name) VALUES(${customerId},'Corner Deli','Checkout regression customer')`;
    const draft = await createDraftOrderWithVariants({ business: "Corner Deli", source: "web", serviceType: "pickup", customerId, createdBy: "web:checkout-race-test", customerFirstName: "Test", callerPhone: "3155550198", items: [{ itemId, quantity: 1 }] });
    orderId = String(draft.id);
    const amount = Number(draft.amount_due_cents);
    await sql`INSERT INTO ordering_customer_web_sessions(session_hash,last_seen_at,expires_at) VALUES(${hash},NOW(),NOW()+INTERVAL '1 day')`;
    await sql`INSERT INTO ordering_customer_web_carts(order_id,session_hash) VALUES(${orderId},${hash})`;
    const wrongBrowser = customerSessionCookie({ sessionId: randomUUID(), customerId, authenticatedAt: Date.now(), expiresAt: Date.now()+86_400_000 }).split(";")[0];
    for (const redeem of [redeemLoyalty, redeemPoints]) {
      const response = await redeem(new Request(`http://localhost/api/customer/orders/${orderId}/rewards`, { method: "POST", headers: { cookie: wrongBrowser, "content-type": "application/json" }, body: JSON.stringify({}) }), { params: Promise.resolve({ id: orderId }) });
      assert.equal(response.status, 409);
      assert.match(String((await response.json()).error), /checkout is no longer available/, "Another browser cannot change the customer's active checkout.");
    }
    await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,expires_at) VALUES(${checkoutId},'Corner Deli',${orderId},${amount},${Math.floor(Math.random()*1_000_000_000)+1},${randomUUID()},'web:checkout-race-test',NOW()+INTERVAL '1 hour')`;
    const replayId = Number((await sql`SELECT replay_id FROM ordering_mx_checkout_sessions WHERE id=${checkoutId}`)[0].replay_id);
    // A real failure after approval: the item became unavailable while paying.
    await sql`UPDATE ordering_menu_items SET available=FALSE WHERE id=${itemId}`;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "checkout.invalid", "Unexpected outbound request blocked.");
      if (init?.method === "DELETE") { voids += 1; return Response.json({}); }
      if (url.searchParams.has("replayId")) {
        reads += 1;
        if (reads === 1) await bothReading;
        else { secondRead(); await firstCompleted; }
      }
      return Response.json({ id: `test-${checkoutId}`, status: voids ? "Voided" : "Approved", amount: (amount / 100).toFixed(2), cardAccount: { cardType: "Visa", last4: "4242" } });
    };
    const cookie = customerSessionCookie({ sessionId, customerId: null, authenticatedAt: null, expiresAt: Date.now()+86_400_000 }).split(";")[0];
    const confirm = async () => {
      const response = await POST(new Request(`http://localhost/api/customer/orders/${orderId}/payments/mx`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "confirm", replayId }) }), { params: Promise.resolve({ id: orderId }) });
      return { status: response.status, body: await response.json() };
    };
    const first = confirm().finally(firstFinished);
    const second = confirm();
    const answers = await Promise.all([first, second]);
    for (const answer of answers) { assert.equal(answer.status, 409); assert.equal(answer.body.paymentRecorded, true); }
    assert.equal(voids, 0, "A duplicate confirmation must never void the legitimate approved charge.");
    const payments = await sql`SELECT amount_cents FROM ordering_payment_transactions WHERE order_id=${orderId} AND transaction_type='payment'`;
    assert.equal(payments.length, 1);
    assert.equal(Number(payments[0].amount_cents), amount);
    const retry = await confirm();
    assert.equal(retry.status, 409);
    assert.equal(retry.body.paymentRecorded, true, "A paid draft must not be reported as successfully submitted on retry.");

    // A fully rewarded curbside pizza must submit without a zero-dollar charge.
    const manager = { id: "checkout-regression-manager", name: "Regression manager", type: "employee" as const, role: "manager" as const };
    const webActor = { id: "web:checkout-race-test", name: "Online customer", type: "web" as const };
    await sql`UPDATE ordering_menu_items SET available=TRUE WHERE id=${itemId}`;
    async function changedTotalReversal(fails: boolean, recovery: "voided" | "refunded" = "voided") {
      const changedDraft = await createDraftOrderWithVariants({ business: "Corner Deli", source: "web", serviceType: "pickup", customerId, createdBy: webActor.id, customerFirstName: "Test", callerPhone: "3155550198", items: [{ itemId, quantity: 1 }] });
      const changedOrderId = String(changedDraft.id), changedSessionId = randomUUID();
      driftOrderIds.push(changedOrderId);
      const changedAmount = Number(changedDraft.amount_due_cents), changedReplay = Math.floor(Math.random() * 1_000_000_000) + 1;
      await sql`INSERT INTO ordering_customer_web_carts(order_id,session_hash) VALUES(${changedOrderId},${hash})`;
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,expires_at) VALUES(${changedSessionId},'Corner Deli',${changedOrderId},${changedAmount},${changedReplay},${randomUUID()},${webActor.id},NOW()+INTERVAL '1 hour')`;
      // Cover both older keyed web sessions and the explicit online channel.
      if (recovery === "refunded") await sql`UPDATE ordering_mx_checkout_sessions SET channel='online' WHERE id=${changedSessionId}`;
      await sql`UPDATE ordering_orders SET tip_cents=100,total_cents=total_cents+100,amount_due_cents=amount_due_cents+100 WHERE id=${changedOrderId}`;
      let replayReads = 0, reversals = 0, outbound = 0;
      let reviewedPayment: Record<string, unknown> | null = null;
      let reviewUnavailable = false;
      let bothApproved!: () => void;
      const approvalsReady = new Promise<void>((resolve) => { bothApproved = resolve; });
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid", "Unexpected outbound request blocked.");
        outbound += 1;
        if (reviewUnavailable) return Response.json({ message: "Unavailable" }, { status: 503 });
        if (url.searchParams.has("replayId")) {
          replayReads += 1;
          if (replayReads === 2) bothApproved();
          await approvalsReady;
          // Both tabs have the same approval and stale initialized session.
          return Response.json({ id: `test-${changedSessionId}`, status: "Approved", amount: (changedAmount / 100).toFixed(2) });
        }
        if (init?.method === "DELETE") {
          reversals += 1;
          assert.equal(reversals, 1, "Only the request holding the durable reversal claim may contact MX.");
          return Response.json(fails ? { message: "Simulated processor outage" } : {}, { status: fails ? 500 : 200 });
        }
        return Response.json(reviewedPayment || { id: `test-${changedSessionId}`, status: reversals && !fails ? "Voided" : "Approved", amount: (changedAmount / 100).toFixed(2) });
      };
      const attempt = async (action = "confirm") => {
        const response = await POST(new Request(`http://localhost/api/customer/orders/${changedOrderId}/payments/mx`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action, replayId: changedReplay }) }), { params: Promise.resolve({ id: changedOrderId }) });
        return { status: response.status, body: await response.json() };
      };
      const results = await Promise.all([attempt(), attempt()]);
      for (const result of results) assert.equal(result.status, 409);
      assert.equal(reversals, 1);
      const [state] = await sql`SELECT status,provider_transaction_reference,status_message FROM ordering_mx_checkout_sessions WHERE id=${changedSessionId}`;
      assert.equal(state.status, fails ? "needs_review" : "voided", "A concurrent stale confirm must not overwrite the reversal outcome.");
      assert.equal(state.provider_transaction_reference, `test-${changedSessionId}`);
      if (fails) assert.match(String(state.status_message), /failed.*Check MX Merchant/);
      assert.equal((await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=${changedOrderId}`).length, 0);
      const beforeRetry = outbound;
      const retried = await attempt();
      assert.equal(retried.status, 409);
      assert.match(String(retried.body.error), fails ? /store is checking/ : /cancelled that charge/);
      if (fails) {
        const restart = await attempt("initialize");
        assert.equal(restart.status, 409);
        assert.match(String(restart.body.error), /don't pay again/);
      }
      assert.equal(outbound, beforeRetry, "Voided/review retries must not request another reversal or charge.");
      if (fails) {
        assert.ok((await listWebPaymentsNeedingReview("Corner Deli")).some(row => row.id === changedSessionId));
        assert.ok((await listWaitingOnlineOrders("Corner Deli")).some(row => row.id === changedOrderId), "Unrecorded web charges must alert staff.");
        await assert.rejects(assertOrderCanTakePayment(changedOrderId, "Corner Deli"), /manager check/);
        await assert.rejects(commitTender({ orderId: changedOrderId, business: "Corner Deli", tenderType: "card", amountTenderedCents: changedAmount + 100, clientMutationId: randomUUID(), actor: manager, providerApproval: { provider: "test", transactionReference: "must-not-record" } }), /manager check/);
        const review = { business: "Corner Deli" as const, sessionId: changedSessionId, note: "Checked original charge in MX", actor: manager };
        await assert.rejects(resolveWebPaymentReview({ ...review, actor: { ...manager, role: "employee" } }), /Only a manager/);
        await assert.rejects(resolveTerminalSaleReview(review), /not waiting for review/, "Terminal acknowledgement must not bypass web verification.");
        await assert.rejects(resolveWebPaymentReview(review), /still shows money charged/);
        reviewUnavailable = true;
        await assert.rejects(resolveWebPaymentReview(review), /could not verify/);
        reviewUnavailable = false;
        reviewedPayment = { id: `test-${changedSessionId}`, status: "Settled", amount: (changedAmount / 100).toFixed(2), refundedAmount: ((changedAmount - 1) / 100).toFixed(2) };
        await assert.rejects(resolveWebPaymentReview(review), /still shows money charged/, "A partial refund cannot unblock a second full charge.");
        // A staff key-in on a web order is a different workflow and must not be
        // exposed or resolved through the online reversal queue.
        await sql`UPDATE ordering_mx_checkout_sessions SET channel='keyed',created_by='employee:fixture' WHERE id=${changedSessionId}`;
        assert.ok(!(await listWebPaymentsNeedingReview("Corner Deli")).some(row => row.id === changedSessionId));
        await assert.rejects(resolveWebPaymentReview(review), /not waiting for review/);
        await sql`UPDATE ordering_mx_checkout_sessions SET channel=${recovery === "refunded" ? "online" : "keyed"},created_by=${webActor.id} WHERE id=${changedSessionId}`;
        reviewedPayment = { id: `test-${changedSessionId}`, status: recovery === "voided" ? "Voided" : "Settled", amount: (changedAmount / 100).toFixed(2), refundedAmount: recovery === "refunded" ? (changedAmount / 100).toFixed(2) : 0 };
        await resolveWebPaymentReview(review);
        const [resolved] = await sql`SELECT status,reviewed_by,reviewed_at,review_note FROM ordering_mx_checkout_sessions WHERE id=${changedSessionId}`;
        assert.equal(resolved.status, "voided");
        assert.equal(resolved.reviewed_by, manager.id);
        assert.ok(resolved.reviewed_at);
        assert.equal(resolved.review_note, review.note);
        assert.ok(!(await listWebPaymentsNeedingReview("Corner Deli")).some(row => row.id === changedSessionId));
        assert.ok(!(await listWaitingOnlineOrders("Corner Deli")).some(row => row.id === changedOrderId));
        await assertOrderCanTakePayment(changedOrderId, "Corner Deli");
        assert.equal(reversals, 1, "Staff verification only reads MX; it never sends another reversal.");
        assert.equal((await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=${changedOrderId}`).length, 0, "Review must not invent a recorded payment.");
      }
    }
    await changedTotalReversal(false);
    await changedTotalReversal(true);
    await changedTotalReversal(true, "refunded");
    await sql`INSERT INTO ordering_loyalty_programs(id,business,name,customer_name,qualifying_rule,reward_rule,active,version,priority,stackable,updated_by) VALUES(${programId},'Corner Deli',${`Checkout reward ${programId}`},'Checkout reward',${JSON.stringify({ itemIds: [itemId], quantityRequired: 10 })}::jsonb,${JSON.stringify({ itemIds: [itemId], quantity: 1 })}::jsonb,TRUE,1,10000,FALSE,'validator')`;
    await adjustLoyalty({ customerId, programId, deltaUnits: 10, reason: "Full reward checkout regression", actor: manager });
    const zeroDraft = await createDraftOrderWithVariants({ business: "Corner Deli", source: "web", serviceType: "curbside", customerId, createdBy: webActor.id, customerFirstName: "Test", callerPhone: "3155550198", items: [{ itemId, quantity: 1 }] });
    zeroOrderId = String(zeroDraft.id);
    const lineId = String((await sql`SELECT id FROM ordering_order_items WHERE order_id=${zeroOrderId}`)[0].id);
    await requestLoyaltyRedemption({ orderId: zeroOrderId, orderItemId: lineId, programId, actor: webActor });
    const before = reads;
    const sent = await submitZeroBalanceCustomerOrder(zeroOrderId, webActor);
    assert.equal(sent.order.status, "sent_to_kitchen");
    assert.equal(sent.order.payment_status, "paid");
    assert.equal(Number(sent.order.total_cents), 0);
    assert.equal(reads, before, "A free order must not contact the payment processor.");
    assert.equal((await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=${zeroOrderId}`).length, 0);
    await submitZeroBalanceCustomerOrder(zeroOrderId, webActor);
    assert.equal((await sql`SELECT id FROM ordering_loyalty_ledger WHERE order_id=${zeroOrderId} AND entry_type='redeem'`).length, 1);
    // Exercise real guest routes with SMS enforcement deterministic, rolling back
    // the setting and draft so the test never changes the running test app's setup.
    const rollbackGuest = new Error("rollback guest checkout fixture");
    try {
      await withTransaction(async () => {
        const tx = getSql();
        await tx`UPDATE ordering_business_ordering_settings SET sms_verification_bypass_until=NULL WHERE business='Corner Deli'`;
        const guest = await createCart(new Request("http://localhost/api/customer/cart", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ serviceType: "pickup", timingMode: "asap", firstName: "Guest", lastName: "Regression", phone: "3155550173", email: "guest@example.com", items: [{ itemId, quantity: 1 }] }) }));
        assert.equal(guest.status, 201, JSON.stringify(await guest.clone().json()));
        const guestOrderId = String((await guest.json()).cart.id);
        const blocked = await payLater(new Request(`http://localhost/api/customer/orders/${guestOrderId}/pay-later`, { method: "POST", headers: { cookie } }), { params: Promise.resolve({ id: guestOrderId }) });
        assert.equal(blocked.status, 403);
        assert.equal((await blocked.json()).code, "sms_verification_required");
        const cardGate = await POST(new Request(`http://localhost/api/customer/orders/${guestOrderId}/payments/mx`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "unknown" }) }), { params: Promise.resolve({ id: guestOrderId }) });
        assert.equal(cardGate.status, 409);
        assert.equal((await cardGate.json()).error, "Unknown payment action.", "Guests should pass ownership checks without signing in.");
        throw rollbackGuest;
      });
    } catch (error) { if (error !== rollbackGuest) throw error; }
    console.log(JSON.stringify({ concurrentConfirmationKeepsPayment: true, oneRecordedTender: true, paidDraftRetryNeedsAssistance: true, rewardsRequireOwnedCart: true, fullyRewardedCurbsideWithoutCharge: true, guestCartAndPayLaterVerification: true, concurrentAmountDriftReversesOnce: true, failedReversalRemainsReviewable: true, staffReviewRequiresConfirmedReversal: true }));
  } finally {
    globalThis.fetch = originalFetch;
    if (fixtureWindows.length) await sql`DELETE FROM ordering_operating_windows WHERE id=ANY(${fixtureWindows}::uuid[])`;
    if (zeroOrderId) {
      await sql`DELETE FROM ordering_print_jobs WHERE order_id=${zeroOrderId}`;
      await sql`DELETE FROM ordering_order_loyalty_applications WHERE order_id=${zeroOrderId}`;
      await sql`DELETE FROM ordering_loyalty_ledger WHERE order_id=${zeroOrderId}`;
      await sql`DELETE FROM ordering_orders WHERE id=${zeroOrderId}`;
    }
    await sql`DELETE FROM ordering_loyalty_ledger WHERE program_id=${programId}`;
    await sql`DELETE FROM ordering_loyalty_programs WHERE id=${programId}`;
    for (const driftOrderId of driftOrderIds) {
      await sql`DELETE FROM ordering_mx_checkout_sessions WHERE order_id=${driftOrderId}`;
      await sql`DELETE FROM ordering_orders WHERE id=${driftOrderId}`;
    }
    if (orderId) {
      await sql`DELETE FROM ordering_print_jobs WHERE order_id=${orderId}`;
      await sql`DELETE FROM ordering_mx_checkout_sessions WHERE order_id=${orderId}`;
      await sql`DELETE FROM ordering_payment_transactions WHERE order_id=${orderId}`;
      await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
    }
    await sql`DELETE FROM ordering_customer_web_sessions WHERE session_hash=${hash}`;
    await sql`DELETE FROM ordering_customers WHERE id=${customerId}`;
    await sql`DELETE FROM ordering_menu_items WHERE id=${itemId}`;
    await sql`DELETE FROM ordering_menu_categories WHERE id=${categoryId}`;
  }
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

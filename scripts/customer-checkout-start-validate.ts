// Disposable database only. MX and Google calls are intercepted before any route runs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

async function main() {
  const database = new URL(process.env.DATABASE_URL || "");
  assert.ok(/test|regression/.test(database.pathname) || (process.env.ORDERING_AUDIT_DATABASE === "1" && process.env.CI === "true"), "Use a disposable test database.");
  assert.equal(process.env.VALIDATION_DISABLE_OUTBOUND, "1");
  // Next normally installs this before importing route modules. The isolated
  // route runner supplies it so successful submissions can register after().
  Object.assign(globalThis, { AsyncLocalStorage });
  Object.assign(process.env, {
    MX_ENVIRONMENT: "sandbox", MX_MERCHANT_ID: "test-merchant", MX_CONSUMER_KEY: "test-key", MX_CONSUMER_SECRET: "test-secret",
    MX_TEST_API_BASE_URL: "http://checkout.invalid/checkout/v3", ADDRESS_PROVIDER: "google", GOOGLE_MAPS_API_KEY: "test-key",
    DELI_ORIGIN_LATITUDE: "44.697", DELI_ORIGIN_LONGITUDE: "-75.486", DELI_DELIVERY_RADIUS_MILES: "12",
  });
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { customerSessionCookie, customerSessionHash } = await import("../src/lib/customer-ordering-session");
  const { POST: payment } = await import("../src/app/api/customer/orders/[id]/payments/mx/route");
  const { POST: delivery } = await import("../src/app/api/customer/orders/[id]/delivery/route");
  const { createAddressValidationToken } = await import("../src/lib/ordering-address");
  const { saveOrderDeliveryAddress } = await import("../src/lib/ordering-address-schema");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const sql = getSql();
  const categoryId = randomUUID(), itemId = randomUUID(), sessionId = randomUUID();
  const hash = customerSessionHash(sessionId);
  const cookie = customerSessionCookie({ sessionId, customerId: null, authenticatedAt: null, expiresAt: Date.now() + 86_400_000 }).split(";")[0];
  const orders: string[] = [], fixtureWindows: string[] = [], extraSessionHashes: string[] = [];
  const originalFetch = globalThis.fetch;
  let checked = 0;
  globalThis.fetch = async () => { throw new Error("Unexpected outbound request blocked."); };
  async function draft(serviceType: "pickup" | "delivery" = "pickup") {
    await sql`UPDATE ordering_menu_items SET available=TRUE WHERE id=${itemId}`;
    const order = await createDraftOrderWithVariants({ business: "Corner Deli", source: "web", serviceType,
      customerFirstName: "Checkout", callerPhone: "3155550199", createdBy: "web:checkout-start-regression", items: [{ itemId, quantity: 10 }] });
    const id = String(order.id); orders.push(id);
    await sql`INSERT INTO ordering_customer_web_carts(order_id,session_hash) VALUES(${id},${hash})`;
    return { id, amount: Number(order.amount_due_cents) };
  }
  async function initialize(id: string, requestCookie = cookie) {
    return payment(new Request(`http://localhost/api/customer/orders/${id}/payments/mx`, {
      method: "POST", headers: { cookie: requestCookie, "content-type": "application/json", "cf-connecting-ip": `checkout-${sessionId}` },
      body: JSON.stringify({ action: "initialize" }),
    }), { params: Promise.resolve({ id }) });
  }
  try {
    if (!(await sql`SELECT 1 FROM ordering_operating_windows WHERE business='Corner Deli' LIMIT 1`)[0]) {
      for (let weekday = 0; weekday < 7; weekday++) {
        const id = randomUUID(); fixtureWindows.push(id);
        await sql`INSERT INTO ordering_operating_windows(id,business,service_type,weekday,opens_at,closes_at,updated_by)
          VALUES(${id},'Corner Deli','all',${weekday},'00:00','23:59','checkout-start-regression')`;
      }
    }
    await sql`INSERT INTO ordering_menu_categories(id,business,name) VALUES(${categoryId},'Corner Deli',${`Checkout start regression ${categoryId}`})`;
    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) VALUES(${itemId},'Corner Deli',${categoryId},'Checkout start regression',1000)`;
    await sql`INSERT INTO ordering_customer_web_sessions(session_hash,last_seen_at,expires_at) VALUES(${hash},NOW(),NOW()+INTERVAL '1 day')`;

    for (const scenario of ["superseded", "declined", "expired", "sixth-attempt", "settled"]) {
      const { id, amount } = await draft();
      const approvedReplay = Math.floor(Math.random() * 1_000_000_000) + 1;
      const checkoutId = randomUUID();
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,status,created_at,expires_at)
        VALUES(${checkoutId},'Corner Deli',${id},${amount},${approvedReplay},${randomUUID()},'web:checkout-start-regression','online',${["superseded", "declined"].includes(scenario) ? scenario : "initialized"},NOW()-INTERVAL '8 hours',NOW()-INTERVAL '7 hours')`;
      if (scenario === "sixth-attempt") {
        for (let index = 0; index < 5; index++) {
          await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,expires_at)
            VALUES(${randomUUID()},'Corner Deli',${id},${amount},${approvedReplay + index + 1},${randomUUID()},'web:checkout-start-regression','online',NOW()+INTERVAL '30 minutes')`;
        }
        await sql`UPDATE ordering_mx_checkout_sessions SET created_at=NOW()-INTERVAL '1 hour' WHERE id=${checkoutId}`;
      }
      // Stop submission after recording the recovered charge. This also verifies
      // that initialize retains the paid-but-needs-help response, with no token.
      await sql`UPDATE ordering_menu_items SET available=FALSE WHERE id=${itemId}`;
      let lookups = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid");
        assert.ok(url.searchParams.has("replayId"), "Recovery must not issue a new card token.");
        lookups++;
        if (Number(url.searchParams.get("replayId")) !== approvedReplay) return Response.json({}, { status: 404 });
        return Response.json({ id: `test-${checkoutId}`, status: scenario === "settled" ? "Settled" : "Approved", amount: (amount / 100).toFixed(2) });
      };
      const response = await initialize(id), body = await response.json();
      assert.equal(response.status, 409, scenario);
      assert.equal(body.paymentRecorded, true, `${scenario}: a late approval must be recorded before offering another payment`);
      assert.equal(lookups, scenario === "sixth-attempt" ? 6 : 1);
      assert.equal((await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=${id} AND transaction_type='payment'`).length, 1);
      await sql`UPDATE ordering_mx_checkout_sessions SET status='voided' WHERE order_id=${id} AND status<>'completed'`;
      checked++;
    }

    for (const scenario of ["partial-refund", "wrong-amount"]) {
      const { id, amount } = await draft();
      const checkoutId = randomUUID(), replayId = Math.floor(Math.random() * 1_000_000_000) + 1;
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,expires_at)
        VALUES(${checkoutId},'Corner Deli',${id},${amount},${replayId},${randomUUID()},'web:checkout-start-regression','online',NOW()+INTERVAL '30 minutes')`;
      let requests = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid");
        assert.ok(url.searchParams.has("replayId"));
        requests++;
        return Response.json({ id: `test-${checkoutId}`, status: "Settled", amount: ((amount + (scenario === "wrong-amount" ? 100 : 0)) / 100).toFixed(2), refundedAmount: scenario === "partial-refund" ? "1.00" : "0.00" });
      };
      const response = await initialize(id);
      assert.equal(response.status, 409);
      assert.match(String((await response.json()).error), /store is checking/);
      assert.equal((await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE id=${checkoutId}`)[0].status, "needs_review");
      assert.equal((await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=${id}`).length, 0);
      const { id: nextId } = await draft();
      const blocked = await initialize(nextId);
      assert.equal(blocked.status, 409);
      assert.match(String((await blocked.json()).error), /don't pay again/);
      assert.equal(requests, 1, "An unresolved old charge must block another cart before contacting MX.");
      await sql`UPDATE ordering_mx_checkout_sessions SET status='voided' WHERE id=${checkoutId}`;
      checked++;
    }

    for (const entry of ["confirm", "initialize"] as const) {
      const { id: oldId, amount } = await draft();
      const replayId = Math.floor(Math.random() * 1_000_000_000) + 1, checkoutId = randomUUID();
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,expires_at)
        VALUES(${checkoutId},'Corner Deli',${oldId},${amount},${replayId},${randomUUID()},'web:checkout-start-regression','online',NOW()+INTERVAL '30 minutes')`;
      await sql`UPDATE ordering_customer_web_carts SET replaced_at=NOW() WHERE order_id=${oldId}`;
      const { id: nextId } = await draft();
      let reversals = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid");
        assert.ok(!url.pathname.includes("/auth/"), "An earlier cart's approval must be settled before another charge.");
        if (init?.method === "DELETE") { reversals++; return Response.json({}); }
        return Response.json({ id: `test-${checkoutId}`, status: reversals ? "Voided" : "Approved", amount: (amount / 100).toFixed(2) });
      };
      const response = entry === "initialize" ? await initialize(nextId) : await payment(new Request(`http://localhost/api/customer/orders/${oldId}/payments/mx`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "confirm", replayId }),
      }), { params: Promise.resolve({ id: oldId }) });
      assert.equal(response.status, 409);
      assert.match(String((await response.json()).error), /cancelled that charge/);
      assert.equal(reversals, 1);
      assert.equal((await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE id=${checkoutId}`)[0].status, "voided");
      assert.equal((await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=ANY(${[oldId, nextId]}::uuid[])`).length, 0);
      assert.equal((await sql`SELECT id FROM ordering_orders WHERE id=ANY(${[oldId, nextId]}::uuid[]) AND status<>'draft'`).length, 0, "Recovering a replaced cart must not send a second kitchen order.");
      checked++;
    }

    for (const change of ["submitted", "amount", "replaced"] as const) {
      const { id } = await draft();
      let pending!: Promise<Response>;
      let outbound = 0;
      globalThis.fetch = async (input) => {
        assert.equal(new URL(String(input)).hostname, "checkout.invalid");
        outbound++;
        return Response.json("test-token");
      };
      await withTransaction(async () => {
        const tx = getSql();
        const key = `mx-online-checkout:${id}`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        // Start the request outside this transaction so it reaches the same
        // advisory lock only after finishing its preflight and balance read.
        const { outsideTransaction } = await import("../src/lib/db");
        pending = outsideTransaction(() => initialize(id));
        let blocked = false;
        const deadline = Date.now() + 15_000;
        while (!blocked && Date.now() < deadline) {
          blocked = (await tx`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=(hashtext(${key})::bigint & 4294967295)::oid`).length > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(blocked, "Initialize did not reach the guarded payment-session creation.");
        if (change === "submitted") await tx`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id=${id}`;
        else if (change === "replaced") await tx`UPDATE ordering_customer_web_carts SET replaced_at=NOW() WHERE order_id=${id}`;
        else await tx`UPDATE ordering_orders SET tip_cents=100,total_cents=total_cents+100,amount_due_cents=amount_due_cents+100 WHERE id=${id}`;
      });
      const response = await pending, body = await response.json();
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.match(String(body.error), change === "amount" ? /total changed/ : /no longer awaiting payment/);
      assert.equal(outbound, 0, "A stale checkout must never issue a new payment token.");
      assert.equal((await sql`SELECT id FROM ordering_mx_checkout_sessions WHERE order_id=${id}`).length, 0);
      checked++;
    }

    for (const status of ["InProgress", "AuthOnly", "TicketOnly", "Chargedback", "UnexpectedStatus", "DeclinedWithoutReference"]) {
      const { id, amount } = await draft();
      const checkoutId = randomUUID(), replayId = Math.floor(Math.random() * 1_000_000_000) + 1;
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,expires_at)
        VALUES(${checkoutId},'Corner Deli',${id},${amount},${replayId},${randomUUID()},'web:checkout-start-regression','online',NOW()+INTERVAL '30 minutes')`;
      let lookups = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid");
        assert.ok(url.searchParams.has("replayId"), "An uncertain processor status must not issue a token.");
        lookups++;
        return Response.json({ id: status === "DeclinedWithoutReference" ? "" : `test-${checkoutId}`, status: status === "DeclinedWithoutReference" ? "Declined" : status, amount: (amount / 100).toFixed(2) });
      };
      const response = await initialize(id);
      assert.equal(response.status, 409, status);
      assert.match(String((await response.json()).error), /still being checked/);
      assert.equal(lookups, 1);
      assert.equal((await sql`SELECT id FROM ordering_mx_checkout_sessions WHERE order_id=${id}`).length, 1);
      await sql`UPDATE ordering_mx_checkout_sessions SET status='voided' WHERE id=${checkoutId}`;
      checked++;
    }

    for (const scenario of ["initialize", "confirm", "completed-retry", "reversal-failure", "lookup-failure"] as const) {
      const { id, amount } = await draft();
      const visitor = randomUUID(), visitorHash = customerSessionHash(visitor);
      extraSessionHashes.push(visitorHash);
      const visitorCookie = customerSessionCookie({ sessionId: visitor, customerId: null, authenticatedAt: null, expiresAt: Date.now() + 86_400_000 }).split(";")[0];
      await sql`INSERT INTO ordering_customer_web_sessions(session_hash,last_seen_at,expires_at) VALUES(${visitorHash},NOW(),NOW()+INTERVAL '1 day')`;
      await sql`UPDATE ordering_customer_web_carts SET session_hash=${visitorHash} WHERE order_id=${id}`;
      const approvals = new Map<number, Record<string, unknown>>();
      const references = new Map<string, Record<string, unknown>>();
      let reversals = 0, unavailableReplay: number | null = null;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid");
        if (url.pathname.includes("/auth/")) return Response.json("test-token");
        if (url.searchParams.has("replayId")) {
          const replay = Number(url.searchParams.get("replayId"));
          if (replay === unavailableReplay) throw new Error("Simulated lookup failure");
          return approvals.has(replay) ? Response.json(approvals.get(replay)) : Response.json({}, { status: 404 });
        }
        const reference = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const result = references.get(reference);
        assert.ok(result, "Only a known approved test charge may be reversed.");
        if (init?.method === "DELETE") {
          reversals++;
          if (scenario === "reversal-failure") return Response.json({ message: "Simulated reversal failure" }, { status: 500 });
          result.status = "Voided";
        }
        return Response.json(result);
      };
      const first = await initialize(id, visitorCookie), firstBody = await first.json();
      assert.equal(first.status, 200, JSON.stringify(firstBody));
      // The browser still has its MX token when our 30-minute local session
      // expires. A second tab now receives a distinct replayId for the same total.
      await sql`UPDATE ordering_mx_checkout_sessions SET expires_at=NOW()-INTERVAL '1 minute' WHERE order_id=${id}`;
      const second = await initialize(id, visitorCookie), secondBody = await second.json();
      assert.equal(second.status, 200, JSON.stringify(secondBody));
      assert.notEqual(firstBody.replayId, secondBody.replayId);
      const approve = (replay: number) => {
        const record = { id: `duplicate-${replay}`, status: "Approved", amount: (amount / 100).toFixed(2) };
        approvals.set(replay, record); references.set(String(record.id), record);
      };
      const confirm = () => payment(new Request(`http://localhost/api/customer/orders/${id}/payments/mx`, {
        method: "POST", headers: { cookie: visitorCookie, "content-type": "application/json" }, body: JSON.stringify({ action: "confirm", replayId: secondBody.replayId }),
      }), { params: Promise.resolve({ id }) });
      // Supply Next's after() context without running confirmation email callbacks.
      const inRequest = <T>(operation: () => Promise<T>) => workAsyncStorage.run({ afterContext: { after() {} } } as never,
        () => workUnitAsyncStorage.run({ type: "request", phase: "action" } as never, operation));
      approve(secondBody.replayId);
      if (scenario === "completed-retry") assert.equal((await inRequest(confirm)).status, 201);
      approve(firstBody.replayId);
      if (scenario === "lookup-failure") unavailableReplay = firstBody.replayId;
      const response = await inRequest(() => scenario === "initialize" ? initialize(id, visitorCookie) : confirm());
      const body = await response.json();
      assert.equal(response.status, ["reversal-failure", "lookup-failure"].includes(scenario) ? 409 : 201, JSON.stringify(body));
      if (response.status === 409) assert.equal(body.paymentRecorded, true, "A second-attempt problem must not hide the successful order payment.");
      assert.equal((await sql`SELECT status FROM ordering_orders WHERE id=${id}`)[0].status, "sent_to_kitchen");
      assert.equal((await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=${id} AND transaction_type='payment'`).length, 1);
      assert.equal((await sql`SELECT id FROM ordering_print_jobs WHERE order_id=${id} AND purpose='kitchen_production'`).length, 1, "Recovery sends one kitchen ticket.");
      if (scenario === "lookup-failure") {
        unavailableReplay = null;
        assert.equal((await inRequest(() => initialize(id, visitorCookie))).status, 201, "An already-sent order can reconcile its remaining charge.");
      }
      assert.equal(reversals, 1, "The extra approval is reversed once, even after the order was already submitted.");
      const states = await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE order_id=${id} ORDER BY created_at`;
      assert.deepEqual(states.map(row => row.status).sort(), scenario === "reversal-failure" ? ["completed", "needs_review"] : ["completed", "voided"]);
      assert.equal((await inRequest(confirm)).status, scenario === "reversal-failure" ? 409 : 201);
      assert.equal(reversals, 1, "A completed confirmation cannot repeat the reversal.");
      checked++;
    }

    for (const status of ["Declined", "Voided", "Settled"]) {
      const { id, amount } = await draft();
      const checkoutId = randomUUID(), replayId = Math.floor(Math.random() * 1_000_000_000) + 1;
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,expires_at)
        VALUES(${checkoutId},'Corner Deli',${id},${amount},${replayId},${randomUUID()},'web:checkout-start-regression','online',NOW()+INTERVAL '30 minutes')`;
      let lookups = 0, tokens = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid");
        if (url.pathname.includes("/auth/")) { tokens++; return Response.json("test-token"); }
        assert.ok(url.searchParams.has("replayId"));
        lookups++;
        return Response.json({ id: `test-${checkoutId}`, status, amount: (amount / 100).toFixed(2), refundedAmount: status === "Settled" ? (amount / 100).toFixed(2) : "0.00" });
      };
      const response = await initialize(id), body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.notEqual(body.replayId, replayId, "A final declined/reversed payment needs a fresh attempt.");
      assert.equal(tokens, 1); assert.equal(lookups, 1);
      const closed = (await sql`SELECT status,provider_transaction_reference FROM ordering_mx_checkout_sessions WHERE id=${checkoutId}`)[0];
      assert.equal(closed.status, status === "Declined" ? "declined" : "voided");
      assert.equal(closed.provider_transaction_reference, `test-${checkoutId}`);
      await sql`UPDATE ordering_mx_checkout_sessions SET status='voided' WHERE order_id=${id}`;
      checked++;
    }

    {
      const { id, amount } = await draft();
      for (let index = 0; index < 5; index++) {
        await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,channel,expires_at)
          VALUES(${randomUUID()},'Corner Deli',${id},${amount},${Math.floor(Math.random() * 1_000_000_000) + 1},${randomUUID()},'web:checkout-start-regression','online',NOW()+INTERVAL '30 minutes')`;
      }
      const realNow = Date.now;
      let lookups = 0, active = 0, maximumActive = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "checkout.invalid");
        assert.ok(url.searchParams.has("replayId"), "An incomplete recovery scan must never issue a token.");
        lookups++; active++; maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        Date.now = () => realNow() + 13_000;
        return Response.json({}, { status: 404 });
      };
      let response: Response;
      try { response = await initialize(id); }
      finally { Date.now = realNow; }
      assert.equal(response.status, 409);
      assert.match(String((await response.json()).error), /more time to check/);
      assert.equal(lookups, 4);
      assert.equal(maximumActive, 4, "Recovery concurrency stays bounded.");
      assert.equal((await sql`SELECT id FROM ordering_mx_checkout_sessions WHERE order_id=${id}`).length, 5, "An unchecked fifth attempt prevents a new payment session.");
      await sql`UPDATE ordering_mx_checkout_sessions SET status='voided' WHERE order_id=${id}`;
      checked++;
    }

    const originalAddress = { enteredAddress: "1 Test St", formattedAddress: "1 Test St, Ogdensburg NY 13669", line1: "1 Test St", city: "Ogdensburg", state: "NY", postalCode: "13669", country: "US", latitude: 44.698, longitude: -75.487, provider: "google" as const, providerReferenceId: "test-place", validatedAt: new Date().toISOString() };
    const nextAddress = { ...originalAddress, enteredAddress: "2 Test St", line1: "2 Test St", formattedAddress: "2 Test St, Ogdensburg NY 13669" };
    for (const change of ["submitted", "paid", "none"] as const) {
      const { id } = await draft("delivery");
      await saveOrderDeliveryAddress({ orderId: id, address: originalAddress });
      const before = (await sql`SELECT total_cents,delivery_fee_cents FROM ordering_orders WHERE id=${id}`)[0];
      globalThis.fetch = async (input) => {
        assert.equal(new URL(String(input)).hostname, "routes.googleapis.com");
        if (change === "submitted") await sql`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id=${id}`;
        if (change === "paid") await sql`UPDATE ordering_orders SET paid_cents=total_cents,amount_due_cents=0,payment_status='paid' WHERE id=${id}`;
        return Response.json({ routes: [{ distanceMeters: 1609, duration: "300s" }] });
      };
      const response = await delivery(new Request(`http://localhost/api/customer/orders/${id}/delivery`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ enteredAddress: nextAddress.enteredAddress, validationToken: createAddressValidationToken(nextAddress) }),
      }), { params: Promise.resolve({ id }) });
      const body = await response.json();
      const saved = (await sql`SELECT line1 FROM ordering_order_delivery_addresses WHERE order_id=${id}`)[0];
      if (change === "none") {
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(saved.line1, nextAddress.line1);
        const after = (await sql`SELECT total_cents,delivery_fee_cents FROM ordering_orders WHERE id=${id}`)[0];
        assert.equal(Number(after.total_cents), body.totalCents);
        assert.equal(Number(after.delivery_fee_cents), body.deliveryFeeCents);
      } else {
        assert.equal(response.status, 409, JSON.stringify(body));
        assert.match(String(body.error), /can no longer be updated/);
        assert.equal(saved.line1, originalAddress.line1, "Routing must not change an order submitted/paid while it was in flight.");
        assert.deepEqual((await sql`SELECT total_cents,delivery_fee_cents FROM ordering_orders WHERE id=${id}`)[0], before);
      }
      checked++;
    }
    console.log(JSON.stringify({ checkoutStartRegressions: checked, lateApprovalRecovery: true, lockedOrderRecheck: true, atomicDeliveryChanges: true }));
  } finally {
    globalThis.fetch = originalFetch;
    for (const id of orders) {
      await sql`DELETE FROM ordering_print_jobs WHERE order_id=${id}`;
      await sql`DELETE FROM ordering_mx_checkout_sessions WHERE order_id=${id}`;
      await sql`DELETE FROM ordering_payment_transactions WHERE order_id=${id}`;
      await sql`DELETE FROM ordering_orders WHERE id=${id}`;
    }
    await sql`DELETE FROM ordering_customer_web_sessions WHERE session_hash=${hash}`;
    if (extraSessionHashes.length) await sql`DELETE FROM ordering_customer_web_sessions WHERE session_hash=ANY(${extraSessionHashes})`;
    await sql`DELETE FROM ordering_menu_items WHERE id=${itemId}`;
    await sql`DELETE FROM ordering_menu_categories WHERE id=${categoryId}`;
    if (fixtureWindows.length) await sql`DELETE FROM ordering_operating_windows WHERE id=ANY(${fixtureWindows}::uuid[])`;
  }
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

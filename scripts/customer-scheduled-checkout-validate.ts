// Regression for a customer who leaves Review open until their scheduled slot
// has passed. Requires an isolated database; every fixture is rolled back and
// outbound requests are rejected.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";

async function main() {
  const database = new URL(process.env.DATABASE_URL || "");
  assert.ok(/test|regression/.test(database.pathname)
    || (process.env.ORDERING_AUDIT_DATABASE === "1" && process.env.CI === "true"), "Use a disposable test database.");
  assert.equal(process.env.VALIDATION_DISABLE_OUTBOUND, "1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected outbound request blocked."); };
  const rollback = new Error("rollback:customer-scheduled-checkout-validation");
  try {
    const { getSql, withTransaction } = await import("../src/lib/db");
    const { createTimedDraftOrder, ensureTimedDraftOrderSchemas } = await import("../src/lib/ordering-timed-orders");
    const { preflightDraftSubmit, submitDraftOrder, OrderConflictError } = await import("../src/lib/ordering-order-lifecycle");
    const { GET: futureAvailability } = await import("../src/app/api/customer/availability/route");
    const { getFulfillmentTimingSettings } = await import("../src/lib/ordering-timing");
    const { orderingLocalDateTime, quoteOrderTiming } = await import("../src/lib/ordering-timing-core");
    const { customerOrderConfirmation } = await import("../src/lib/customer-order-confirmation");
    const { POST: checkIn } = await import("../src/app/api/customer/orders/[id]/arrival/route");
    const { customerSessionCookie, customerSessionHash } = await import("../src/lib/customer-ordering-session");
    await ensureTimedDraftOrderSchemas();
    try {
      await withTransaction(async () => {
        const sql = getSql();
        const categoryId = randomUUID(), itemId = randomUUID();
        // Make the timing boundary independent of the copied store's hours,
        // closures, menu schedules and today's time. These changes roll back.
        await sql`DELETE FROM ordering_operating_windows WHERE business='Corner Deli'`;
        await sql`DELETE FROM ordering_special_hours WHERE business='Corner Deli'`;
        await sql`DELETE FROM ordering_emergency_closures WHERE business='Corner Deli'`;
        for (let weekday = 0; weekday < 7; weekday++) {
          await sql`INSERT INTO ordering_operating_windows(id,business,service_type,weekday,opens_at,closes_at,updated_by)
            VALUES(${randomUUID()},'Corner Deli','all',${weekday},'00:00','23:59','scheduled-checkout-regression')`;
        }
        await sql`UPDATE ordering_fulfillment_timing_settings SET allow_future=TRUE,max_future_days=30 WHERE business='Corner Deli' AND service_type='pickup'`;
        await sql`INSERT INTO ordering_menu_categories(id,business,name) VALUES(${categoryId},'Corner Deli',${`Scheduled checkout ${categoryId}`})`;
        await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) VALUES(${itemId},'Corner Deli',${categoryId},'Scheduled checkout test item',1000)`;
        const actor = { type: "web" as const, id: "web:scheduled-checkout-regression", name: "Online customer" };
        const order = await createTimedDraftOrder({
          business: "Corner Deli", source: "web", serviceType: "pickup", createdBy: actor.id,
          customerFirstName: "Scheduled test", callerPhone: "3155550198",
          timingMode: "future", requestedFor: new Date(Date.now() + 2 * 60 * 60_000),
          items: [{ itemId, quantity: 1 }],
        });
        const id = String(order.id);
        const snapshot = async () => (await sql`SELECT status,version,total_cents,paid_cents,amount_due_cents,
          (SELECT COUNT(*)::int FROM ordering_order_events WHERE order_id=${id}) events,
          (SELECT COUNT(*)::int FROM ordering_print_jobs WHERE order_id=${id}) print_jobs,
          (SELECT COUNT(*)::int FROM ordering_payment_transactions WHERE order_id=${id}) payments
          FROM ordering_orders WHERE id=${id}`)[0];
        const before = await snapshot();
        await preflightDraftSubmit(id, "Corner Deli", actor);
        assert.deepEqual(await snapshot(), before, "A valid future preflight leaves the draft unchanged.");

        // Represent elapsed time between pricing and payment without changing
        // the machine clock or waiting two hours.
        await sql`UPDATE ordering_orders SET scheduled_for=NOW()-INTERVAL '5 minutes',promised_at=NOW()-INTERVAL '5 minutes' WHERE id=${id}`;
        const expired = (error: unknown) => error instanceof OrderConflictError && /future|scheduled|time|expired|passed/i.test(error.message);
        await assert.rejects(preflightDraftSubmit(id, "Corner Deli", actor), expired, "A passed scheduled slot must be rejected before charging.");
        assert.deepEqual(await snapshot(), before, "A rejected preflight leaves the draft unchanged.");
        await assert.rejects(submitDraftOrder(id, "Corner Deli", actor), expired, "Pay-later submission must reject the same passed slot.");
        assert.deepEqual(await snapshot(), before, "An expired slot creates no kitchen job, payment or order event.");

        const sessionId = randomUUID(), sessionHash = customerSessionHash(sessionId);
        await sql`INSERT INTO ordering_customer_web_sessions(session_hash,last_seen_at,expires_at) VALUES(${sessionHash},NOW(),NOW()+INTERVAL '1 day')`;
        await sql`INSERT INTO ordering_customer_web_carts(order_id,session_hash) VALUES(${id},${sessionHash})`;
        const cookie = customerSessionCookie({ sessionId, customerId: null, authenticatedAt: null, expiresAt: Date.now() + 86_400_000 }).split(";")[0];
        const arrival = () => checkIn(new Request(`http://localhost/api/customer/orders/${id}/arrival`, {
          method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ carColor: "Silver", carType: "SUV" }),
        }), { params: Promise.resolve({ id }) });
        await sql`UPDATE ordering_orders SET service_type='curbside',status='sent_to_kitchen',timing_mode='asap',scheduled_for=NULL,
          promised_at=NOW()+INTERVAL '13 hours',quoted_lead_max_minutes=30,kitchen_release_at=NULL WHERE id=${id}`;
        assert.equal((await customerOrderConfirmation(id)).waiting_for_open, true, "An ASAP preorder is queued for opening even though it prints immediately.");
        const earlyArrival = await arrival();
        assert.equal(earlyArrival.status, 409);
        assert.match((await earlyArrival.json()).error, /after the store opens/);
        assert.equal((await sql`SELECT id FROM ordering_curbside_arrivals WHERE order_id=${id}`).length, 0);
        for (const status of ["in_progress", "ready"]) {
          await sql`UPDATE ordering_orders SET status=${status} WHERE id=${id}`;
          assert.equal((await customerOrderConfirmation(id)).waiting_for_open, false, "Actual kitchen progress overrides the original quote.");
          assert.equal((await arrival()).status, 200);
          await sql`DELETE FROM ordering_curbside_arrivals WHERE order_id=${id}`;
        }
        await sql`UPDATE ordering_orders SET status='sent_to_kitchen',promised_at=NOW()+INTERVAL '29 minutes' WHERE id=${id}`;
        assert.equal((await customerOrderConfirmation(id)).waiting_for_open, false, "At opening, an ordinary ASAP order can be made.");
        assert.equal((await arrival()).status, 200);
        await sql`DELETE FROM ordering_curbside_arrivals WHERE order_id=${id}`;
        await sql`UPDATE ordering_orders SET promised_at=NOW()-INTERVAL '1 day' WHERE id=${id}`;
        assert.equal((await arrival()).status, 200, "A delayed pickup is not blocked merely because the store is now closed.");
        await sql`DELETE FROM ordering_curbside_arrivals WHERE order_id=${id}`;
        await sql`UPDATE ordering_orders SET timing_mode='future',kitchen_release_at=NOW()+INTERVAL '2 hours' WHERE id=${id}`;
        assert.equal((await customerOrderConfirmation(id)).held_until_prep, true);
        assert.equal((await arrival()).status, 409, "A held future order cannot signal an early curbside arrival.");

        const slotResponse = async (date: string, serviceType = "pickup") => {
          const response = await futureAvailability(new Request(`http://localhost/api/customer/availability?${new URLSearchParams({ date, serviceType })}`));
          return { status: response.status, body: await response.json() };
        };
        for (const invalid of ["2026-02-30", "2025-02-29", "2026-13-01", "0000-01-01", "2026-1-01", ""]) {
          const result = await slotResponse(invalid);
          assert.equal(result.status, 400, `Invalid calendar date ${invalid} is rejected.`);
          assert.deepEqual(result.body.slots, []);
          assert.match(result.body.error, /valid calendar date/);
        }
        const leapDate = await slotResponse("2028-02-29");
        assert.equal(leapDate.status, 200, "A real leap day is valid even when outside the current booking window.");
        const timezone = "America/New_York";
        await sql`UPDATE ordering_business_ordering_settings SET timezone=${timezone} WHERE business='Corner Deli'`;
        await sql`UPDATE ordering_fulfillment_timing_settings SET active=TRUE,allow_future=FALSE WHERE business='Corner Deli' AND service_type='pickup'`;
        const tomorrow = orderingLocalDateTime(new Date(Date.now() + 86_400_000), timezone).date;
        const disabled = await slotResponse(tomorrow);
        assert.equal(disabled.status, 200);
        assert.deepEqual(disabled.body.slots, []);
        assert.equal(disabled.body.reason, "future_orders_disabled");
        await sql`UPDATE ordering_fulfillment_timing_settings SET allow_future=TRUE,max_future_days=1,normal_min_minutes=90,normal_max_minutes=90 WHERE business='Corner Deli' AND service_type='pickup'`;
        const farDate = orderingLocalDateTime(new Date(Date.now() + 3 * 86_400_000), timezone).date;
        const tooFar = await slotResponse(farDate);
        assert.deepEqual(tooFar.body.slots, []);
        assert.equal(tooFar.body.reason, "future_time_too_far");
        const pastDate = orderingLocalDateTime(new Date(Date.now() - 86_400_000), timezone).date;
        const past = await slotResponse(pastDate);
        assert.deepEqual(past.body.slots, []);
        assert.equal(past.body.reason, "future_time_required");

        const beforeSlots = new Date();
        const lastDay = await slotResponse(tomorrow);
        const afterSlots = new Date();
        assert.ok(lastDay.body.slots.length > 0, "The allowed part of the final booking day remains available.");
        const settings = await getFulfillmentTimingSettings("Corner Deli", "pickup");
        for (const value of lastDay.body.slots) {
          const slot = new Date(value);
          assert.equal(orderingLocalDateTime(slot, timezone).date, tomorrow);
          assert.ok(slot.getTime() > beforeSlots.getTime() + 90 * 60_000, "A slot preserves the configured prep lead.");
          assert.equal(quoteOrderTiming({ now: afterSlots, mode: "future", requestedFor: slot, settings, currentOrdersInBusyWindow: 0 }).accepted, true, "Every offered slot satisfies checkout's timing policy.");
        }
        assert.ok(new Date(lastDay.body.slots.at(-1)).getTime() > beforeSlots.getTime() + 86_400_000 - 15 * 60_000,
          "The final day is filtered at the rolling instant, not truncated to an earlier UTC or local midnight.");

        const leadDate = orderingLocalDateTime(new Date(Date.now() + 120 * 60_000), timezone).date;
        const leadStart = Date.now();
        const nearSlots = await slotResponse(leadDate);
        assert.ok(nearSlots.body.slots.length > 0);
        assert.ok(nearSlots.body.slots.every((value: string) => new Date(value).getTime() > leadStart + 90 * 60_000));
        await sql`UPDATE ordering_fulfillment_timing_settings SET active=TRUE,allow_future=FALSE WHERE business='Corner Deli' AND service_type='curbside'`;
        const curbside = await slotResponse(tomorrow, "curbside");
        assert.deepEqual(curbside.body.slots, []);
        assert.equal(curbside.body.reason, "future_orders_disabled", "Curbside uses its own timing settings instead of pickup's.");
        for (const transition of [
          { now: "2027-03-13T12:30:00Z", date: "2027-03-14", lastLocalTime: "08:30" },
          { now: "2027-11-06T12:30:00Z", date: "2027-11-07", lastLocalTime: "07:30" },
        ]) {
          const clock = Date.parse(transition.now);
          mock.timers.enable({ apis: ["Date"], now: clock });
          try {
            const acrossDst = await slotResponse(transition.date);
            assert.equal(acrossDst.status, 200);
            assert.ok(acrossDst.body.slots.length > 0);
            const last = new Date(acrossDst.body.slots.at(-1));
            assert.equal(last.getTime(), clock + 86_400_000, "The booking horizon follows checkout's elapsed-day rule across DST.");
            assert.equal(orderingLocalDateTime(last, timezone).time, transition.lastLocalTime);
          } finally {
            mock.timers.reset();
          }
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    console.log("PASS: scheduled preflight/send boundaries; preopening confirmation and curbside guards; calendar dates; future enablement; rolling horizon including both DST transitions; prep lead; curbside timing settings. All fixtures rolled back.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });

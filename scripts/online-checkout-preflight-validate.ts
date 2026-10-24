#!/usr/bin/env node
// Online checkout runs every send rule before the card is charged
// (preflightDraftSubmit). Validates against the private local PostgreSQL
// container; every fixture is rolled back.
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:online-checkout-preflight-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { OrderConflictError, preflightDraftSubmit, submitDraftOrder } = await import("../src/lib/ordering-order-lifecycle");
  const { listWaitingOnlineOrders } = await import("../src/lib/ordering-online-alerts");
  await ensureOrderingPosSchema();
  const results: Record<string, unknown> = {};
  const actor = { id: "web:preflight-validation", name: "Online customer", type: "web" as const };
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const item = (await sql`
        SELECT i.id FROM ordering_menu_items i
        WHERE i.business='Corner Deli' AND i.active AND i.available
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id AND g.min_selections>0)
        ORDER BY i.name LIMIT 1`)[0];
      if (!item) throw new Error("No simple menu item to order.");
      const draft = (input: { firstName: string; phone: string }) => createDraftOrderWithVariants({
        business: "Corner Deli", source: "web", serviceType: "pickup", createdBy: actor.id,
        customerFirstName: input.firstName, callerPhone: input.phone,
        items: [{ itemId: String(item.id), quantity: 1 }],
      });
      const snapshot = async (id: string) => (await sql`SELECT status,version,subtotal_cents,total_cents,amount_due_cents,
        (SELECT COUNT(*)::int FROM ordering_print_jobs WHERE order_id=${id}) print_jobs,
        (SELECT COUNT(*)::int FROM ordering_order_events WHERE order_id=${id}) events
        FROM ordering_orders WHERE id=${id}`)[0];

      // A rule that fails is reported before payment and changes nothing.
      const noPhone = await draft({ firstName: "Preflight", phone: "" });
      const beforeFail = JSON.stringify(await snapshot(String(noPhone.id)));
      let rejected = "";
      try { await preflightDraftSubmit(String(noPhone.id), "Corner Deli", actor); }
      catch (error) { if (error instanceof OrderConflictError) rejected = error.message; else throw error; }
      if (rejected !== "Phone number is required for pickup orders.") throw new Error(`Preflight did not reject the missing phone: ${rejected}`);
      if (JSON.stringify(await snapshot(String(noPhone.id))) !== beforeFail) throw new Error("A failed preflight changed the order.");
      results.failingRuleShownBeforePayment = true;

      // A passing preflight leaves the draft exactly as it was, then the real send works.
      const good = await draft({ firstName: "Preflight", phone: "3155550177" });
      const before = JSON.stringify(await snapshot(String(good.id)));
      let hoursClosed = "";
      try { await preflightDraftSubmit(String(good.id), "Corner Deli", actor); }
      catch (error) {
        if (error instanceof OrderConflictError && /ordering hours|closed|not available/i.test(error.message)) hoursClosed = error.message;
        else throw error;
      }
      if (JSON.stringify(await snapshot(String(good.id))) !== before) throw new Error("A preflight changed the order (status, version, totals, print jobs or events).");
      results.preflightLeavesDraftUnchanged = true;
      if (hoursClosed) {
        results.storeClosedNow = hoursClosed;
      } else {
        const sent = await submitDraftOrder(String(good.id), "Corner Deli", actor);
        if (sent.order.status !== "sent_to_kitchen") throw new Error("The draft did not send after a passing preflight.");
        results.sendsAfterPassingPreflight = true;
      }

      // A paid web draft that could not be sent rings the POS alert.
      await sql`UPDATE ordering_orders SET paid_cents=total_cents,amount_due_cents=0,payment_status='paid' WHERE id=${noPhone.id}`;
      const waiting = await listWaitingOnlineOrders("Corner Deli");
      const alert = waiting.find((row) => String(row.id) === String(noPhone.id));
      if (!alert || alert.paid_not_sent !== true) throw new Error("A paid but unsent online order is missing from the POS alert list.");
      results.paidUnsentOrderAlertsPos = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

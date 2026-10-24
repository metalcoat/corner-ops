#!/usr/bin/env node
// Scheduled orders are held from the kitchen until prep time, then released once
// (ordering-kitchen-release.ts). Runs against the dev database; every fixture is rolled back.
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:scheduled-order-hold-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder, listKitchenOrders } = await import("../src/lib/ordering-order-lifecycle");
  const { listWaitingOnlineOrders } = await import("../src/lib/ordering-online-alerts");
  const { releaseHeldKitchenOrders } = await import("../src/lib/ordering-auto-print");
  await ensureOrderingPosSchema();
  const results: Record<string, unknown> = {};
  const actor = { id: "web:hold-validation", name: "Online customer", type: "web" as const };
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const item = (await sql`
        SELECT i.id FROM ordering_menu_items i
        WHERE i.business='Corner Deli' AND i.active AND i.available
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id AND g.min_selections>0)
        ORDER BY i.name LIMIT 1`)[0];
      const draft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "web", serviceType: "pickup", createdBy: actor.id,
        customerFirstName: "Hold", callerPhone: "3155550178", items: [{ itemId: String(item.id), quantity: 1 }],
      });
      // Due in 6 hours. On Halloween or Super Bowl Sunday nothing is held, and the test says so.
      await sql`UPDATE ordering_orders SET timing_mode='future', scheduled_for=NOW()+INTERVAL '6 hours', quoted_lead_max_minutes=30 WHERE id=${draft.id}`;
      // Needs the store to take orders for that time (run it during the day).
      await submitDraftOrder(String(draft.id), "Corner Deli", actor);
      const order = (await sql`SELECT kitchen_release_at, scheduled_for, status FROM ordering_orders WHERE id=${draft.id}`)[0];
      const holiday = !order.kitchen_release_at;
      if (holiday) { results.todayPrintsEverything = true; throw new Error(ROLLBACK); }
      const minutesBefore = (new Date(order.scheduled_for).getTime() - new Date(order.kitchen_release_at).getTime()) / 60_000;
      if (minutesBefore !== 40) throw new Error(`Release should be 40 min before due, was ${minutesBefore}.`);
      results.heldUntilPrep = true;
      const kitchen = ((await listKitchenOrders("Corner Deli")) as Array<Record<string, unknown>>).find((row) => String(row.id) === String(draft.id));
      if (!kitchen?.held_until_prep) throw new Error("The kitchen screen didn't mark the order as held.");
      results.kitchenScreenShowsHeld = true;
      if ((await listWaitingOnlineOrders("Corner Deli")).some((row) => String(row.id) === String(draft.id))) throw new Error("A held order rang the online-order alert.");
      results.noChimeWhileHeld = true;
      await sql`UPDATE ordering_orders SET kitchen_release_at=NOW()-INTERVAL '1 minute' WHERE id=${draft.id}`;
      await releaseHeldKitchenOrders("Corner Deli");
      await releaseHeldKitchenOrders("Corner Deli");
      const events = await sql`SELECT COUNT(*)::int count FROM ordering_order_events WHERE order_id=${draft.id} AND event_type='kitchen_released'`;
      if (Number(events[0].count) !== 1) throw new Error("The order was not released exactly once.");
      if (!(await listWaitingOnlineOrders("Corner Deli")).some((row) => String(row.id) === String(draft.id))) throw new Error("A released order didn't ring the online-order alert.");
      results.releasedOnceAndChimes = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

#!/usr/bin/env node
// A cancelled item stays cancelled when the order is reopened, added to, repriced
// and sent again. Runs against the dev database; every fixture is rolled back.
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:cancelled-item-reopen-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");
  const { createDraftOrderWithVariants, appendConfiguredOrderItemsWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder, reopenOrderForAdditions } = await import("../src/lib/ordering-order-lifecycle");
  const { cancelOrderItem } = await import("../src/lib/ordering-item-cancellations");
  const { recalculateOrder } = await import("../src/lib/ordering-orders");
  await ensureOrderingPosSchema();
  const manager = { id: "cancel-reopen-manager", name: "Manager", type: "employee" as const, role: "manager" as const };
  const results: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const items = await sql`
        SELECT i.id, i.base_price_cents FROM ordering_menu_items i
        WHERE i.business='Corner Deli' AND i.active AND i.available AND i.base_price_cents>0
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id AND g.min_selections>0)
        ORDER BY i.name LIMIT 2`;
      const draft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: manager.id,
        customerFirstName: "Cancel", callerPhone: "3155550180",
        items: [{ itemId: String(items[0].id), quantity: 2 }],
      });
      await submitDraftOrder(String(draft.id), "Corner Deli", manager);
      const line = (await sql`SELECT id, line_total_cents FROM ordering_order_items WHERE order_id=${draft.id}`)[0];
      await cancelOrderItem({ orderId: String(draft.id), itemId: String(line.id), quantity: 1, reason: "Out of it", clientMutationId: randomUUID(), actor: manager });
      const afterCancel = Number((await sql`SELECT subtotal_cents FROM ordering_orders WHERE id=${draft.id}`)[0].subtotal_cents);
      await reopenOrderForAdditions(String(draft.id), "Corner Deli", manager);
      await appendConfiguredOrderItemsWithVariants(String(draft.id), "Corner Deli", [{ itemId: String(items[1].id), quantity: 1 }]);
      await recalculateOrder(String(draft.id));
      const added = Number(items[1].base_price_cents);
      const afterAdd = Number((await sql`SELECT subtotal_cents FROM ordering_orders WHERE id=${draft.id}`)[0].subtotal_cents);
      if (afterAdd !== afterCancel + added) throw new Error(`Reopen + add should be ${afterCancel + added}, got ${afterAdd} (the cancelled unit came back).`);
      results.cancelledUnitStaysOff = true;
      await submitDraftOrder(String(draft.id), "Corner Deli", manager);
      results.sendsAfterReopen = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

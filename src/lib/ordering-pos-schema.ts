import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";
import { ensureOrderingInventorySchema } from "@/lib/ordering-inventory-schema";

let posSchemaPromise: Promise<void> | null = null;

/**
 * Operational POS schema layered on top of the shared ordering foundation.
 *
 * Covers registers/cash control, future orders, delivery assignment, bar tabs,
 * promotions, gift/store credit, closeout, audit, and offline idempotency. The
 * schema is intentionally additive while the replacement POS is developed in
 * parallel with the incumbent system.
 */
export function ensureOrderingPosSchema(): Promise<void> {
  if (!posSchemaPromise) {
    posSchemaPromise = (async () => {
      await ensureOrderingAccountSchema();
      await ensureOrderingChannelSchema();
      await ensureOrderingInventorySchema();
    })().catch((error) => {
      posSchemaPromise = null;
      throw error;
    });
  }

  return posSchemaPromise;
}

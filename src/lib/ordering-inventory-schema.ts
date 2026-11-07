import { ensureSchema } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";

let inventorySchemaPromise: Promise<void> | null = null;

/**
 * Inventory foundation for POS adjustments, receiving, physical counts, and
 * future recipe/menu depletion. The movement ledger is authoritative; callers
 * should reverse incorrect movements rather than deleting history.
 */
export function ensureOrderingInventorySchema(): Promise<void> {
  if (!inventorySchemaPromise) {
    inventorySchemaPromise = (async () => {
      await ensureSchema();
      await ensureOrderingSchema();
    })().catch((error) => {
      inventorySchemaPromise = null;
      throw error;
    });
  }

  return inventorySchemaPromise;
}

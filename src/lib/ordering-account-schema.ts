import { ensureSchema } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";

let orderingAccountSchemaPromise: Promise<void> | null = null;

/**
 * Ordering extensions for saved payment references, order follow-up links,
 * employee meal comps, and house accounts.
 *
 * This stores no raw card data. Payment-method rows contain only provider
 * references and safe display metadata.
 */
export function ensureOrderingAccountSchema(): Promise<void> {
  if (!orderingAccountSchemaPromise) {
    orderingAccountSchemaPromise = (async () => {
      await ensureSchema();
      await ensureOrderingSchema();
    })().catch((error) => {
      orderingAccountSchemaPromise = null;
      throw error;
    });
  }

  return orderingAccountSchemaPromise;
}

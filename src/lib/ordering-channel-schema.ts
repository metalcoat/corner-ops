import { ensureOrderingSchema } from "@/lib/ordering-db";

let channelSchemaPromise: Promise<void> | null = null;

/**
 * Ordering extensions for restaurant-specific modifiers/combos, online-order
 * verification, and curbside arrival. Kept separate while the POS foundation
 * is developed so it can be reviewed before any production cutover.
 */
export function ensureOrderingChannelSchema(): Promise<void> {
  if (!channelSchemaPromise) {
    channelSchemaPromise = (async () => {
      await ensureOrderingSchema();
    })().catch((error) => {
      channelSchemaPromise = null;
      throw error;
    });
  }

  return channelSchemaPromise;
}

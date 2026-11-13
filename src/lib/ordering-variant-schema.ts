import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";

let variantSchemaPromise: Promise<void> | null = null;

/**
 * Item variants keep one logical menu item while allowing selectable sizes/forms
 * to change both the base price and modifier pricing. Examples are pizza sizes
 * and Half / Whole / Wrap sub forms. A variant only exists on items that truly
 * support it, so an ineligible sub simply has no Wrap variant for any client to
 * offer or accept.
 */
export function ensureOrderingVariantSchema(): Promise<void> {
  if (!variantSchemaPromise) {
    variantSchemaPromise = (async () => {
      await ensureOrderingChannelSchema();
    })().catch((error) => {
      variantSchemaPromise = null;
      throw error;
    });
  }

  return variantSchemaPromise;
}

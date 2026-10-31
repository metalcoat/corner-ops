import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";

let menuImportSchemaPromise: Promise<void> | null = null;

/**
 * Tracks one-time/external menu migrations without coupling the live menu model
 * to Rezku. Imported records keep their source IDs so repeated development
 * imports can update the same internal records rather than duplicating them.
 */
export function ensureOrderingMenuImportSchema(): Promise<void> {
  if (!menuImportSchemaPromise) {
    menuImportSchemaPromise = (async () => {
      await ensureOrderingVariantSchema();
    })().catch((error) => {
      menuImportSchemaPromise = null;
      throw error;
    });
  }

  return menuImportSchemaPromise;
}

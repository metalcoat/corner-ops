import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";

let schemaPromise: Promise<void> | null = null;

export async function ensureOrderingBarcodeSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = (async () => {
    await ensureOrderingVariantSchema();
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

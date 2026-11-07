import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";

let schemaPromise: Promise<void> | null = null;
export function ensureCustomerOrderingSchema(): Promise<void> {
  if (!schemaPromise)
    schemaPromise = (async () => {
      await ensureOrderingCustomerSchema();
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  return schemaPromise;
}

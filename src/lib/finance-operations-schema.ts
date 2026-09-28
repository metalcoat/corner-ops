import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { ensureSchema, getSql } from "@/lib/db";

let schemaPromise: Promise<void> | null = null;

export function ensureFinanceOperationsSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await Promise.all([ensureSchema(), ensureAccountingControlSchema()]);
      const sql = getSql();

    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

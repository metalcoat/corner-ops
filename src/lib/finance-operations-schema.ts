import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { ensureSchema, getSql } from "@/lib/db";

let schemaPromise: Promise<void> | null = null;

export function ensureFinanceOperationsSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await Promise.all([ensureSchema(), ensureAccountingControlSchema()]);
      const sql = getSql();



      await sql`CREATE UNIQUE INDEX IF NOT EXISTS vendor_bills_invoice_unique ON vendor_bills (business, LOWER(vendor), invoice_number) WHERE invoice_number <> '' AND status <> 'Void'`;




    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

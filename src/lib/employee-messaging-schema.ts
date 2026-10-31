import { ensureSchema } from "@/lib/db";

let employeeMessagingSchemaPromise: Promise<void> | null = null;

/**
 * Login-time employee messages, targeting, and acknowledgement receipts.
 */
export function ensureEmployeeMessagingSchema(): Promise<void> {
  if (!employeeMessagingSchemaPromise) {
    employeeMessagingSchemaPromise = (async () => {
      await ensureSchema();
    })().catch((error) => {
      employeeMessagingSchemaPromise = null;
      throw error;
    });
  }

  return employeeMessagingSchemaPromise;
}

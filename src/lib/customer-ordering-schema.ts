import { getSql } from "@/lib/db";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";

let schemaPromise: Promise<void> | null = null;
export function ensureCustomerOrderingSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = (async () => {
    await ensureOrderingCustomerSchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_customer_web_sessions (
      session_hash TEXT PRIMARY KEY,
      customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
      authenticated_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_customer_web_carts (
      order_id UUID PRIMARY KEY REFERENCES ordering_orders(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL REFERENCES ordering_customer_web_sessions(session_hash) ON DELETE CASCADE,
      replaced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_customer_web_carts_session_idx ON ordering_customer_web_carts(session_hash,created_at DESC)`;
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

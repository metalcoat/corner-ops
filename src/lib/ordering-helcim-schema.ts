import { getSql } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";

let promise: Promise<void> | null = null;
export function ensureOrderingHelcimSchema() {
  if (!promise) promise = (async () => {
    await ensureOrderingAccountSchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_helcim_checkout_sessions (
      id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      order_id UUID NOT NULL REFERENCES ordering_orders(id), check_id UUID,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), checkout_token TEXT NOT NULL UNIQUE,
      secret_hash TEXT NOT NULL, client_mutation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized','completed','expired')),
      provider_transaction_reference TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_helcim_checkout_order_idx ON ordering_helcim_checkout_sessions(order_id,created_at DESC)`;
  })();
  return promise;
}

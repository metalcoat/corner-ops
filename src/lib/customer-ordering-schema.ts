import { getSql } from "@/lib/db";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";

let schemaPromise: Promise<void> | null = null;
export function ensureCustomerOrderingSchema(): Promise<void> {
  if (!schemaPromise)
    schemaPromise = (async () => {
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
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS confirmation_email_error TEXT NOT NULL DEFAULT ''`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_customer_identities (
        id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, provider_subject TEXT NOT NULL, email TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(provider,provider_subject)
      )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_customer_identity_email_idx ON ordering_customer_identities(provider,email)`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_customer_email_codes (
        id UUID PRIMARY KEY,email TEXT NOT NULL,code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
        used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_email_codes_lookup_idx ON ordering_customer_email_codes(email,created_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_customer_phone_codes (
        id UUID PRIMARY KEY,customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
        normalized_phone TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_phone_codes_lookup_idx ON ordering_customer_phone_codes(customer_id,normalized_phone,created_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_customer_login_phone_codes (
        id UUID PRIMARY KEY,normalized_phone TEXT NOT NULL,customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
        code_hash TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
        used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_login_phone_codes_lookup_idx ON ordering_customer_login_phone_codes(normalized_phone,created_at DESC)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  return schemaPromise;
}

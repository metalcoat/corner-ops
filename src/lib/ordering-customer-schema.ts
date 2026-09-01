import { getSql } from "@/lib/db";
import { ensureOrderingAddressSchema } from "@/lib/ordering-address-schema";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

let promise: Promise<void> | null = null;

/** Additive CRM, POS preference, and immutable order-snapshot schema. */
export function ensureOrderingCustomerSchema(): Promise<void> {
  if (!promise)
    promise = (async () => {
      await ensureOrderingAddressSchema();
      await ensureOrderingMenuOverrideSchema();
      const sql = getSql();
      await sql`ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS merged_into_customer_id UUID REFERENCES ordering_customers(id)`;
      await sql`ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS last_order_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_customer_phones ADD COLUMN IF NOT EXISTS display_phone TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_customer_phones ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
      await sql`ALTER TABLE ordering_customer_phones ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS standardized_address TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS provider_reference_id TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7)`;
      await sql`ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7)`;
      await sql`ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS first_name_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS last_name_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS phone_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS email_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS order_origin TEXT NOT NULL DEFAULT 'pos'`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS customer_phone_id UUID REFERENCES ordering_customer_phones(id) ON DELETE SET NULL`;
      await sql`ALTER TABLE ordering_order_delivery_addresses ADD COLUMN IF NOT EXISTS customer_address_id UUID REFERENCES ordering_customer_addresses(id)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_customer_search_idx ON ordering_orders (business, created_at DESC, payment_status)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customers_merged_idx ON ordering_customers (business, merged_into_customer_id)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_phones_customer_active_idx ON ordering_customer_phones (customer_id, is_primary DESC, last_used_at DESC NULLS LAST)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_customer_phone_idx ON ordering_orders (customer_phone_id)`;
      await sql`WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY created_at,id) position FROM ordering_customer_phones WHERE is_primary=TRUE) UPDATE ordering_customer_phones phone SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE phone.id=ranked.id AND ranked.position>1`;
      await sql`WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY last_used_at DESC NULLS LAST,created_at,id) position FROM ordering_customer_addresses WHERE is_primary=TRUE AND active=TRUE) UPDATE ordering_customer_addresses address SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE address.id=ranked.id AND ranked.position>1`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_customer_phones_one_primary_idx ON ordering_customer_phones (customer_id) WHERE is_primary=TRUE`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_customer_addresses_one_primary_idx ON ordering_customer_addresses (customer_id) WHERE is_primary=TRUE AND active=TRUE`;
      await sql`
      CREATE TABLE IF NOT EXISTS ordering_business_settings (
        business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
        pos_idle_lock_seconds INTEGER NOT NULL DEFAULT 60 CHECK (pos_idle_lock_seconds = 0 OR pos_idle_lock_seconds BETWEEN 15 AND 3600),
        online_order_alert_sound TEXT NOT NULL DEFAULT 'kitchen_ring',
        online_order_alert_volume INTEGER NOT NULL DEFAULT 100,
        business_timezone TEXT NOT NULL DEFAULT 'America/New_York',
        updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
      await sql`ALTER TABLE ordering_business_settings ADD COLUMN IF NOT EXISTS online_order_alert_sound TEXT NOT NULL DEFAULT 'kitchen_ring'`;
      await sql`ALTER TABLE ordering_business_settings ADD COLUMN IF NOT EXISTS online_order_alert_volume INTEGER NOT NULL DEFAULT 100`;
      await sql`INSERT INTO ordering_business_settings (business) VALUES ('Corner Deli'), ('Tiki') ON CONFLICT DO NOTHING`;
      await sql`
      CREATE TABLE IF NOT EXISTS ordering_customer_merge_events (
        id UUID PRIMARY KEY, business TEXT NOT NULL, surviving_customer_id UUID NOT NULL REFERENCES ordering_customers(id),
        merged_customer_id UUID NOT NULL REFERENCES ordering_customers(id), actor_id TEXT NOT NULL,
        field_choices JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (surviving_customer_id <> merged_customer_id)
      )
    `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_merge_events_customer_idx ON ordering_customer_merge_events (surviving_customer_id, created_at DESC)`;

      await sql`ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS amount TEXT NOT NULL DEFAULT 'normal'`;
      await sql`ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS was_default_selected_snapshot BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS default_amount_snapshot TEXT NOT NULL DEFAULT 'normal'`;
      await sql`ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS print_on_ticket BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS supports_intensity BOOLEAN NOT NULL DEFAULT FALSE`;
    })().catch((error) => {
      promise = null;
      throw error;
    });
  return promise;
}

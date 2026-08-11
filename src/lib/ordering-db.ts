import { getSql } from "@/lib/db";

let orderingSchemaPromise: Promise<void> | null = null;

/**
 * Creates the database foundation shared by POS, web, kiosk, and AI ordering.
 *
 * This intentionally lives outside the legacy/core schema initializer so the
 * ordering platform can be developed and validated independently before any
 * production cutover.
 */
export function ensureOrderingSchema(): Promise<void> {
  if (!orderingSchemaPromise) {
    orderingSchemaPromise = (async () => {
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_customers (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          display_name TEXT NOT NULL DEFAULT '',
          first_name TEXT NOT NULL DEFAULT '',
          last_name TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customers_business_name_idx ON ordering_customers (business, active, display_name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_customer_phones (
          id UUID PRIMARY KEY,
          customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          normalized_phone TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          is_primary BOOLEAN NOT NULL DEFAULT FALSE,
          verified_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (customer_id, normalized_phone)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_phones_lookup_idx ON ordering_customer_phones (normalized_phone)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_customer_addresses (
          id UUID PRIMARY KEY,
          customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          label TEXT NOT NULL DEFAULT '',
          line1 TEXT NOT NULL,
          line2 TEXT NOT NULL DEFAULT '',
          city TEXT NOT NULL,
          state TEXT NOT NULL,
          postal_code TEXT NOT NULL,
          delivery_notes TEXT NOT NULL DEFAULT '',
          is_primary BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_addresses_customer_idx ON ordering_customer_addresses (customer_id, active)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_categories (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_categories_business_idx ON ordering_menu_categories (business, active, sort_order, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_items (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          category_id UUID NOT NULL REFERENCES ordering_menu_categories(id),
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          sku TEXT NOT NULL DEFAULT '',
          base_price_cents INTEGER NOT NULL CHECK (base_price_cents >= 0),
          taxable BOOLEAN NOT NULL DEFAULT TRUE,
          available BOOLEAN NOT NULL DEFAULT TRUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, category_id, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_items_business_category_idx ON ordering_menu_items (business, category_id, active, available, sort_order, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_modifier_groups (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          min_selections INTEGER NOT NULL DEFAULT 0 CHECK (min_selections >= 0),
          max_selections INTEGER NOT NULL DEFAULT 1 CHECK (max_selections >= 1),
          allow_option_quantity BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (max_selections >= min_selections),
          UNIQUE (business, name)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_modifier_options (
          id UUID PRIMARY KEY,
          group_id UUID NOT NULL REFERENCES ordering_modifier_groups(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          price_delta_cents INTEGER NOT NULL DEFAULT 0,
          available BOOLEAN NOT NULL DEFAULT TRUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (group_id, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_modifier_options_group_idx ON ordering_modifier_options (group_id, active, available, sort_order, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_item_modifier_groups (
          id UUID PRIMARY KEY,
          item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
          group_id UUID NOT NULL REFERENCES ordering_modifier_groups(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (item_id, group_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_item_modifier_groups_item_idx ON ordering_menu_item_modifier_groups (item_id, sort_order)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_loyalty_programs (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          qualifying_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
          reward_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_orders (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          source TEXT NOT NULL CHECK (source IN ('pos', 'web', 'ai_phone', 'kiosk', 'import')),
          customer_id UUID REFERENCES ordering_customers(id),
          caller_phone TEXT NOT NULL DEFAULT '',
          three_cx_call_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'sent_to_kitchen', 'in_progress', 'ready', 'completed', 'cancelled')),
          payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'failed')),
          service_type TEXT NOT NULL DEFAULT 'pickup' CHECK (service_type IN ('pickup', 'delivery', 'dine_in', 'bar')),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          subtotal_cents INTEGER NOT NULL DEFAULT 0,
          discount_cents INTEGER NOT NULL DEFAULT 0,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          tip_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL DEFAULT 0,
          paid_cents INTEGER NOT NULL DEFAULT 0,
          amount_due_cents INTEGER NOT NULL DEFAULT 0,
          promised_at TIMESTAMPTZ,
          special_instructions TEXT NOT NULL DEFAULT '',
          handoff_reason TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (subtotal_cents >= 0),
          CHECK (discount_cents >= 0),
          CHECK (tax_cents >= 0),
          CHECK (tip_cents >= 0),
          CHECK (total_cents >= 0),
          CHECK (paid_cents >= 0),
          CHECK (amount_due_cents >= 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_business_created_idx ON ordering_orders (business, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_customer_idx ON ordering_orders (customer_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_active_idx ON ordering_orders (business, status, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_3cx_call_idx ON ordering_orders (three_cx_call_id) WHERE three_cx_call_id <> ''`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_order_items (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          item_id UUID NOT NULL REFERENCES ordering_menu_items(id),
          item_name_snapshot TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
          unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
          modifier_total_cents INTEGER NOT NULL DEFAULT 0,
          line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
          special_instructions TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_order_items_order_idx ON ordering_order_items (order_id, sort_order, created_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_order_item_modifiers (
          id UUID PRIMARY KEY,
          order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
          group_id UUID NOT NULL REFERENCES ordering_modifier_groups(id),
          option_id UUID NOT NULL REFERENCES ordering_modifier_options(id),
          group_name_snapshot TEXT NOT NULL,
          option_name_snapshot TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
          unit_price_delta_cents INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (order_item_id, group_id, option_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_order_item_modifiers_item_idx ON ordering_order_item_modifiers (order_item_id, group_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_loyalty_ledger (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          program_id UUID NOT NULL REFERENCES ordering_loyalty_programs(id),
          customer_id UUID NOT NULL REFERENCES ordering_customers(id),
          order_id UUID REFERENCES ordering_orders(id),
          entry_type TEXT NOT NULL CHECK (entry_type IN ('earn', 'redeem', 'reversal', 'adjustment', 'expire')),
          delta_units INTEGER NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_loyalty_ledger_balance_idx ON ordering_loyalty_ledger (program_id, customer_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_loyalty_ledger_order_idx ON ordering_loyalty_ledger (order_id) WHERE order_id IS NOT NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_upsell_rules (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          condition_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
          offer_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_upsell_rules_business_idx ON ordering_upsell_rules (business, active, priority DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_call_sessions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          three_cx_call_id TEXT NOT NULL UNIQUE,
          caller_phone TEXT NOT NULL DEFAULT '',
          customer_id UUID REFERENCES ordering_customers(id),
          order_id UUID REFERENCES ordering_orders(id),
          state TEXT NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing', 'ai', 'handoff_pending', 'human', 'ended')),
          owner_type TEXT NOT NULL DEFAULT 'ai' CHECK (owner_type IN ('ai', 'employee', 'none')),
          owner_id TEXT NOT NULL DEFAULT '',
          handoff_reason TEXT NOT NULL DEFAULT '',
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_call_sessions_active_idx ON ordering_call_sessions (business, state, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_call_sessions_phone_idx ON ordering_call_sessions (caller_phone, started_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_order_events (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          order_version INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('ai', 'employee', 'customer', 'system', 'payment', 'web')),
          actor_id TEXT NOT NULL DEFAULT '',
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_order_events_order_idx ON ordering_order_events (order_id, order_version, created_at)`;
    })().catch((error) => {
      orderingSchemaPromise = null;
      throw error;
    });
  }

  return orderingSchemaPromise;
}

import { getSql } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";
import { ensureOrderingInventorySchema } from "@/lib/ordering-inventory-schema";

let posSchemaPromise: Promise<void> | null = null;

/**
 * Operational POS schema layered on top of the shared ordering foundation.
 *
 * Covers registers/cash control, future orders, delivery assignment, bar tabs,
 * promotions, gift/store credit, closeout, audit, and offline idempotency. The
 * schema is intentionally additive while the replacement POS is developed in
 * parallel with the incumbent system.
 */
export function ensureOrderingPosSchema(): Promise<void> {
  if (!posSchemaPromise) {
    posSchemaPromise = (async () => {
      await ensureOrderingAccountSchema();
      await ensureOrderingChannelSchema();
      await ensureOrderingInventorySchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_business_counters (
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          counter_name TEXT NOT NULL,
          next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (business, counter_name)
        )
      `;

      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS display_number TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS held_until TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS table_label TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS guest_count INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS tax_exempt_reason TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_display_number_idx ON ordering_orders (business, display_number) WHERE display_number <> ''`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_orders_display_number_unique_idx ON ordering_orders (business, display_number) WHERE display_number <> ''`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_scheduled_idx ON ordering_orders (business, scheduled_for) WHERE scheduled_for IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_orders_kitchen_queue_idx ON ordering_orders (business, status, submitted_at) WHERE status IN ('sent_to_kitchen', 'in_progress', 'ready')`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_pos_terminals (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          terminal_key TEXT NOT NULL,
          terminal_type TEXT NOT NULL DEFAULT 'pos' CHECK (terminal_type IN ('pos', 'bar', 'kiosk', 'manager', 'mobile')),
          location_label TEXT NOT NULL DEFAULT '',
          active BOOLEAN NOT NULL DEFAULT TRUE,
          allow_cash BOOLEAN NOT NULL DEFAULT TRUE,
          allow_offline_cash BOOLEAN NOT NULL DEFAULT TRUE,
          last_seen_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, terminal_key),
          UNIQUE (business, name)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_register_sessions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          terminal_id UUID NOT NULL REFERENCES ordering_pos_terminals(id),
          employee_id UUID REFERENCES employees(id),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'counting', 'closed', 'needs_review')),
          opening_cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash_cents >= 0),
          expected_cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (expected_cash_cents >= 0),
          counted_cash_cents INTEGER CHECK (counted_cash_cents IS NULL OR counted_cash_cents >= 0),
          over_short_cents INTEGER,
          opened_by TEXT NOT NULL,
          closed_by TEXT NOT NULL DEFAULT '',
          opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          notes TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_one_open_register_per_terminal ON ordering_register_sessions (terminal_id) WHERE status IN ('open', 'counting')`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_register_sessions_business_idx ON ordering_register_sessions (business, opened_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_cash_drawer_movements (
          id UUID PRIMARY KEY,
          register_session_id UUID NOT NULL REFERENCES ordering_register_sessions(id) ON DELETE CASCADE,
          order_id UUID REFERENCES ordering_orders(id),
          payment_transaction_id UUID REFERENCES ordering_payment_transactions(id),
          movement_type TEXT NOT NULL CHECK (movement_type IN ('sale', 'refund', 'paid_in', 'paid_out', 'drop', 'driver_turn_in', 'opening_float', 'close_adjustment')),
          delta_cash_cents INTEGER NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          employee_id UUID REFERENCES employees(id),
          approved_by TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          CHECK (delta_cash_cents <> 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_cash_drawer_movements_session_idx ON ordering_cash_drawer_movements (register_session_id, created_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_driver_cash_settlements (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          driver_employee_id UUID NOT NULL REFERENCES employees(id),
          register_session_id UUID REFERENCES ordering_register_sessions(id),
          business_date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'voided')),
          order_count INTEGER NOT NULL DEFAULT 0 CHECK (order_count >= 0),
          expected_cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (expected_cash_cents >= 0),
          turned_in_cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (turned_in_cash_cents >= 0),
          over_short_cents INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL,
          approved_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          posted_at TIMESTAMPTZ,
          notes TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_driver_cash_settlements_driver_idx ON ordering_driver_cash_settlements (driver_employee_id, business_date DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_driver_cash_settlement_orders (
          id UUID PRIMARY KEY,
          settlement_id UUID NOT NULL REFERENCES ordering_driver_cash_settlements(id) ON DELETE CASCADE,
          order_id UUID NOT NULL REFERENCES ordering_orders(id),
          amount_due_cents INTEGER NOT NULL CHECK (amount_due_cents >= 0),
          cash_payment_transaction_id UUID REFERENCES ordering_payment_transactions(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (settlement_id, order_id)
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_cash_order_once_per_posted_settlement ON ordering_driver_cash_settlement_orders (order_id) WHERE cash_payment_transaction_id IS NOT NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_delivery_assignments (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          driver_employee_id UUID NOT NULL REFERENCES employees(id),
          status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled')),
          cash_expected_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_expected_cents >= 0),
          assigned_by TEXT NOT NULL,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          departed_at TIMESTAMPTZ,
          delivered_at TIMESTAMPTZ,
          notes TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_delivery_assignments_driver_idx ON ordering_delivery_assignments (driver_employee_id, status, assigned_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_delivery_assignments_order_idx ON ordering_delivery_assignments (order_id, assigned_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_capacity_windows (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          service_type TEXT NOT NULL CHECK (service_type IN ('pickup', 'delivery', 'no_contact_delivery', 'dine_in', 'curbside', 'bar')),
          starts_at TIMESTAMPTZ NOT NULL,
          ends_at TIMESTAMPTZ NOT NULL,
          max_orders INTEGER,
          max_points INTEGER,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'limited', 'closed')),
          note TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (ends_at > starts_at),
          CHECK (max_orders IS NULL OR max_orders >= 0),
          CHECK (max_points IS NULL OR max_points >= 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_capacity_windows_lookup_idx ON ordering_capacity_windows (business, service_type, starts_at, ends_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_order_capacity_usage (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          capacity_window_id UUID NOT NULL REFERENCES ordering_capacity_windows(id) ON DELETE CASCADE,
          points INTEGER NOT NULL DEFAULT 1 CHECK (points >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (order_id, capacity_window_id)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_promotions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          promotion_type TEXT NOT NULL CHECK (promotion_type IN ('amount_off', 'percent_off', 'fixed_price', 'bogo', 'bundle', 'automatic')),
          priority INTEGER NOT NULL DEFAULT 0,
          rule JSONB NOT NULL DEFAULT '{}'::jsonb,
          adjustment JSONB NOT NULL DEFAULT '{}'::jsonb,
          starts_at TIMESTAMPTZ,
          ends_at TIMESTAMPTZ,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          requires_code BOOLEAN NOT NULL DEFAULT FALSE,
          code TEXT NOT NULL DEFAULT '',
          manager_only BOOLEAN NOT NULL DEFAULT FALSE,
          stackable BOOLEAN NOT NULL DEFAULT FALSE,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_promotions_active_idx ON ordering_promotions (business, active, priority DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_order_adjustments (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          order_item_id UUID REFERENCES ordering_order_items(id) ON DELETE CASCADE,
          promotion_id UUID REFERENCES ordering_promotions(id),
          adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('discount', 'comp', 'void', 'price_override', 'coupon', 'loyalty_reward')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
          reason_code TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          employee_id UUID REFERENCES employees(id),
          approved_by TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reversed_at TIMESTAMPTZ,
          reversal_reason TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_order_adjustments_order_idx ON ordering_order_adjustments (order_id, created_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_bar_tabs (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business = 'Tiki'),
          customer_id UUID REFERENCES ordering_customers(id),
          tab_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed', 'abandoned', 'needs_review')),
          opened_by_employee_id UUID REFERENCES employees(id),
          current_employee_id UUID REFERENCES employees(id),
          payment_method_id UUID REFERENCES ordering_customer_payment_methods(id),
          provider_preauth_reference TEXT NOT NULL DEFAULT '',
          preauthorized_cents INTEGER NOT NULL DEFAULT 0 CHECK (preauthorized_cents >= 0),
          opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          notes TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_bar_tabs_open_idx ON ordering_bar_tabs (status, opened_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_bar_tab_orders (
          id UUID PRIMARY KEY,
          tab_id UUID NOT NULL REFERENCES ordering_bar_tabs(id) ON DELETE CASCADE,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (tab_id, order_id)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_gift_cards (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          token_hash TEXT NOT NULL,
          display_last4 TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'expired', 'depleted')),
          purchased_by_customer_id UUID REFERENCES ordering_customers(id),
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          UNIQUE (business, token_hash),
          CHECK (display_last4 = '' OR display_last4 ~ '^[A-Za-z0-9]{4}$')
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_gift_card_ledger (
          id UUID PRIMARY KEY,
          gift_card_id UUID NOT NULL REFERENCES ordering_gift_cards(id) ON DELETE CASCADE,
          order_id UUID REFERENCES ordering_orders(id),
          entry_type TEXT NOT NULL CHECK (entry_type IN ('issue', 'redeem', 'reload', 'refund', 'adjustment', 'expire', 'reversal')),
          delta_balance_cents INTEGER NOT NULL,
          payment_transaction_id UUID REFERENCES ordering_payment_transactions(id),
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          note TEXT NOT NULL DEFAULT '',
          CHECK (delta_balance_cents <> 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_gift_card_ledger_card_idx ON ordering_gift_card_ledger (gift_card_id, created_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_store_credit_ledger (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          order_id UUID REFERENCES ordering_orders(id),
          entry_type TEXT NOT NULL CHECK (entry_type IN ('issue', 'redeem', 'refund', 'adjustment', 'expire', 'reversal')),
          delta_balance_cents INTEGER NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          approved_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          CHECK (delta_balance_cents <> 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_store_credit_customer_idx ON ordering_store_credit_ledger (business, customer_id, created_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_receipt_deliveries (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK (channel IN ('print', 'email', 'sms')),
          destination TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
          requested_by TEXT NOT NULL,
          requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sent_at TIMESTAMPTZ,
          error TEXT NOT NULL DEFAULT ''
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_business_closeouts (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          business_date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'closed', 'reopened')),
          gross_sales_cents INTEGER NOT NULL DEFAULT 0,
          net_sales_cents INTEGER NOT NULL DEFAULT 0,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          tips_cents INTEGER NOT NULL DEFAULT 0,
          cash_cents INTEGER NOT NULL DEFAULT 0,
          card_cents INTEGER NOT NULL DEFAULT 0,
          house_account_cents INTEGER NOT NULL DEFAULT 0,
          gift_card_cents INTEGER NOT NULL DEFAULT 0,
          store_credit_cents INTEGER NOT NULL DEFAULT 0,
          employee_meal_cents INTEGER NOT NULL DEFAULT 0,
          manager_comp_cents INTEGER NOT NULL DEFAULT 0,
          refund_cents INTEGER NOT NULL DEFAULT 0,
          void_cents INTEGER NOT NULL DEFAULT 0,
          expected_cash_cents INTEGER NOT NULL DEFAULT 0,
          counted_cash_cents INTEGER,
          over_short_cents INTEGER,
          opened_tabs_count INTEGER NOT NULL DEFAULT 0,
          unsettled_driver_orders_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL,
          closed_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          notes TEXT NOT NULL DEFAULT '',
          UNIQUE (business, business_date)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_pos_audit_events (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          event_type TEXT NOT NULL,
          order_id UUID REFERENCES ordering_orders(id),
          employee_id UUID REFERENCES employees(id),
          terminal_id UUID REFERENCES ordering_pos_terminals(id),
          actor TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_pos_audit_business_idx ON ordering_pos_audit_events (business, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_pos_audit_order_idx ON ordering_pos_audit_events (order_id, created_at) WHERE order_id IS NOT NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_offline_mutations (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          terminal_id UUID NOT NULL REFERENCES ordering_pos_terminals(id),
          client_mutation_id TEXT NOT NULL,
          mutation_type TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'applied', 'rejected', 'conflict')),
          result JSONB NOT NULL DEFAULT '{}'::jsonb,
          client_created_at TIMESTAMPTZ,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          applied_at TIMESTAMPTZ,
          UNIQUE (terminal_id, client_mutation_id)
        )
      `;

      await sql`ALTER TABLE ordering_order_links DROP CONSTRAINT IF EXISTS ordering_order_links_relation_type_check`;
      await sql`
        ALTER TABLE ordering_order_links
        ADD CONSTRAINT ordering_order_links_relation_type_check
        CHECK (relation_type IN (
          'add_on',
          'payment_followup',
          'replacement',
          'complaint_remake',
          'split',
          'merge',
          'reopen',
          'duplicate',
          'other'
        ))
      `;
    })().catch((error) => {
      posSchemaPromise = null;
      throw error;
    });
  }

  return posSchemaPromise;
}

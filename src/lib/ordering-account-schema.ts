import { getSql } from "@/lib/db";
import { ensureSchema } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";

let orderingAccountSchemaPromise: Promise<void> | null = null;

/**
 * Ordering extensions for saved payment references, order follow-up links,
 * employee meal comps, and house accounts.
 *
 * This stores no raw card data. Payment-method rows contain only provider
 * references and safe display metadata.
 */
export function ensureOrderingAccountSchema(): Promise<void> {
  if (!orderingAccountSchemaPromise) {
    orderingAccountSchemaPromise = (async () => {
      await ensureSchema();
      await ensureOrderingSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_customer_payment_methods (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          provider_customer_reference TEXT NOT NULL DEFAULT '',
          provider_payment_method_reference TEXT NOT NULL,
          brand TEXT NOT NULL DEFAULT '',
          last4 TEXT NOT NULL DEFAULT '',
          exp_month INTEGER,
          exp_year INTEGER,
          reusable BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          consent_source TEXT NOT NULL DEFAULT '',
          consent_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (last4 = '' OR last4 ~ '^[0-9]{4}$'),
          CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
          UNIQUE (business, provider, provider_payment_method_reference)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_customer_payment_methods_customer_idx ON ordering_customer_payment_methods (customer_id, business, active)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_payment_transactions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          order_id UUID REFERENCES ordering_orders(id),
          customer_id UUID REFERENCES ordering_customers(id),
          payment_method_id UUID REFERENCES ordering_customer_payment_methods(id),
          tender_type TEXT NOT NULL CHECK (tender_type IN ('cash', 'card', 'house_account', 'employee_meal', 'manager_comp', 'store_credit', 'other')),
          transaction_type TEXT NOT NULL DEFAULT 'payment' CHECK (transaction_type IN ('payment', 'refund', 'void', 'adjustment')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'voided', 'refunded', 'failed')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
          provider TEXT NOT NULL DEFAULT '',
          provider_transaction_reference TEXT NOT NULL DEFAULT '',
          brand TEXT NOT NULL DEFAULT '',
          last4 TEXT NOT NULL DEFAULT '',
          related_transaction_id UUID REFERENCES ordering_payment_transactions(id),
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          CHECK (last4 = '' OR last4 ~ '^[0-9]{4}$')
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_payment_transactions_order_idx ON ordering_payment_transactions (order_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_payment_transactions_customer_idx ON ordering_payment_transactions (customer_id, created_at DESC)`;
      await sql`ALTER TABLE ordering_payment_transactions DROP CONSTRAINT IF EXISTS ordering_payment_transactions_tender_type_check`;
      await sql`
        ALTER TABLE ordering_payment_transactions
        ADD CONSTRAINT ordering_payment_transactions_tender_type_check
        CHECK (tender_type IN ('cash', 'card', 'gift_card', 'house_account', 'employee_meal', 'manager_comp', 'store_credit', 'other'))
      `;
      await sql`ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS client_mutation_id TEXT`;
      await sql`ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS check_id UUID`;
      await sql`ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS amount_tendered_cents INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS change_due_cents INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_payment_transactions_idempotency_idx ON ordering_payment_transactions (business, client_mutation_id) WHERE client_mutation_id IS NOT NULL`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS paid_by TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS voided_by TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS void_reason TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS pre_void_status TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS pre_void_payment_status TEXT NOT NULL DEFAULT ''`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_print_jobs (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          order_id UUID NOT NULL REFERENCES ordering_orders(id),
          check_id UUID,
          payment_transaction_id UUID REFERENCES ordering_payment_transactions(id),
          purpose TEXT NOT NULL CHECK (purpose IN ('kitchen_production', 'order_update', 'payment_update', 'paid_receipt')),
          event_subtype TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('queued', 'attempting', 'succeeded', 'failed', 'not_configured')),
          is_reprint BOOLEAN NOT NULL DEFAULT FALSE,
          queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          attempted_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
          error_message TEXT NOT NULL DEFAULT '',
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_print_jobs_order_idx ON ordering_print_jobs (order_id, created_at)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_print_jobs_payment_once_idx ON ordering_print_jobs (payment_transaction_id, purpose) WHERE payment_transaction_id IS NOT NULL AND is_reprint = FALSE`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_print_jobs_kitchen_once_idx ON ordering_print_jobs (order_id, purpose) WHERE purpose = 'kitchen_production' AND is_reprint = FALSE`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_checks (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          display_sequence INTEGER NOT NULL CHECK (display_sequence > 0),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_paid','paid','voided')),
          total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
          paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
          amount_due_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_due_cents >= 0),
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(order_id, display_sequence)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_checks_order_idx ON ordering_checks(order_id, display_sequence)`;
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_check_line_assignments (
          check_id UUID NOT NULL REFERENCES ordering_checks(id) ON DELETE CASCADE,
          order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          allocated_cents INTEGER NOT NULL CHECK (allocated_cents >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(check_id, order_item_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_check_lines_item_idx ON ordering_check_line_assignments(order_item_id)`;
      await sql`ALTER TABLE ordering_check_line_assignments DROP CONSTRAINT IF EXISTS ordering_check_line_assignments_order_item_id_fkey`;
      await sql`ALTER TABLE ordering_check_line_assignments ADD CONSTRAINT ordering_check_line_assignments_order_item_id_fkey FOREIGN KEY(order_item_id) REFERENCES ordering_order_items(id) ON DELETE CASCADE`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_order_links (
          id UUID PRIMARY KEY,
          original_order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          related_order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL CHECK (relation_type IN ('add_on', 'payment_followup', 'replacement', 'complaint_remake', 'other')),
          notes TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (original_order_id <> related_order_id),
          UNIQUE (original_order_id, related_order_id, relation_type)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_order_links_original_idx ON ordering_order_links (original_order_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_order_links_related_idx ON ordering_order_links (related_order_id, created_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_employee_meal_policies (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          min_shift_minutes INTEGER NOT NULL DEFAULT 360 CHECK (min_shift_minutes >= 0),
          max_meals_per_shift INTEGER NOT NULL DEFAULT 1 CHECK (max_meals_per_shift >= 0),
          max_comp_cents INTEGER CHECK (max_comp_cents IS NULL OR max_comp_cents >= 0),
          eligibility_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
          menu_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_employee_meal_comps (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          policy_id UUID NOT NULL REFERENCES ordering_employee_meal_policies(id),
          employee_id UUID NOT NULL REFERENCES employees(id),
          time_entry_id UUID NOT NULL REFERENCES time_entries(id),
          order_id UUID NOT NULL REFERENCES ordering_orders(id),
          meal_sequence INTEGER NOT NULL DEFAULT 1 CHECK (meal_sequence > 0),
          retail_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (retail_amount_cents >= 0),
          comp_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (comp_amount_cents >= 0),
          override_used BOOLEAN NOT NULL DEFAULT FALSE,
          override_reason TEXT NOT NULL DEFAULT '',
          approved_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (time_entry_id, meal_sequence)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_employee_meal_comps_employee_idx ON ordering_employee_meal_comps (employee_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_employee_meal_comps_order_idx ON ordering_employee_meal_comps (order_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_house_accounts (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hold', 'closed')),
          credit_limit_cents INTEGER CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0),
          payment_terms_days INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
          billing_name TEXT NOT NULL DEFAULT '',
          billing_email TEXT NOT NULL DEFAULT '',
          billing_phone TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_house_accounts_business_idx ON ordering_house_accounts (business, status, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_house_account_customers (
          id UUID PRIMARY KEY,
          account_id UUID NOT NULL REFERENCES ordering_house_accounts(id) ON DELETE CASCADE,
          customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          can_charge BOOLEAN NOT NULL DEFAULT TRUE,
          label TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (account_id, customer_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_house_account_customers_customer_idx ON ordering_house_account_customers (customer_id, can_charge)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_house_account_ledger (
          id UUID PRIMARY KEY,
          account_id UUID NOT NULL REFERENCES ordering_house_accounts(id) ON DELETE CASCADE,
          order_id UUID REFERENCES ordering_orders(id),
          payment_transaction_id UUID REFERENCES ordering_payment_transactions(id),
          entry_type TEXT NOT NULL CHECK (entry_type IN ('charge', 'payment', 'credit', 'refund', 'reversal', 'adjustment')),
          delta_balance_cents INTEGER NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          reference TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (delta_balance_cents <> 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_house_account_ledger_account_idx ON ordering_house_account_ledger (account_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_house_account_ledger_order_idx ON ordering_house_account_ledger (order_id) WHERE order_id IS NOT NULL`;
    })().catch((error) => {
      orderingAccountSchemaPromise = null;
      throw error;
    });
  }

  return orderingAccountSchemaPromise;
}

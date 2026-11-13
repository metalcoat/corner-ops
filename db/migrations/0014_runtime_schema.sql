-- Schema the app used to create for itself at startup ("ensure...Schema" functions in src/lib).
-- src/lib/accounting-control.ts:ensureAccountingControlSchema
CREATE TABLE IF NOT EXISTS documents (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            document_date DATE NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('Active', 'Needs Review', 'Archived')),
            notes TEXT NOT NULL DEFAULT '',
            file_name TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size_bytes BIGINT NOT NULL,
            blob_url TEXT NOT NULL UNIQUE,
            blob_pathname TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS documents_business_created_idx ON documents (business, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);
CREATE TABLE IF NOT EXISTS audit_events (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            document_id UUID,
            action TEXT NOT NULL CHECK (action IN ('uploaded', 'updated', 'archived', 'restored', 'deleted')),
            actor TEXT NOT NULL,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS audit_events_business_created_idx ON audit_events (business, created_at DESC);
CREATE TABLE IF NOT EXISTS employees (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            name TEXT NOT NULL,
            pin_hash TEXT NOT NULL,
            position TEXT NOT NULL DEFAULT 'Bartender',
            role_group TEXT NOT NULL DEFAULT 'In-House' CHECK (role_group IN ('Driver', 'In-House', 'Ignore')),
            counts_for_tips BOOLEAN NOT NULL DEFAULT TRUE,
            hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
            tipped_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, pin_hash)
          );
CREATE INDEX IF NOT EXISTS employees_business_active_idx ON employees (business, active, name);
CREATE TABLE IF NOT EXISTS time_entries (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_id UUID NOT NULL REFERENCES employees(id),
            employee_name TEXT NOT NULL,
            position TEXT NOT NULL,
            role_group TEXT NOT NULL CHECK (role_group IN ('Driver', 'In-House', 'Ignore')),
            clock_in TIMESTAMPTZ NOT NULL,
            clock_out TIMESTAMPTZ,
            clock_in_lat NUMERIC(10,7),
            clock_in_lng NUMERIC(10,7),
            clock_in_accuracy NUMERIC(10,2),
            clock_out_lat NUMERIC(10,7),
            clock_out_lng NUMERIC(10,7),
            clock_out_accuracy NUMERIC(10,2),
            source TEXT NOT NULL DEFAULT 'Corner Ops',
            status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Complete', 'Needs Review', 'Corrected')),
            notes TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS time_entries_business_clock_idx ON time_entries (business, clock_in DESC);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_time_entry_per_employee ON time_entries (employee_id) WHERE clock_out IS NULL;
CREATE TABLE IF NOT EXISTS rezku_import_batches (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL DEFAULT 'Corner Deli' CHECK (business = 'Corner Deli'),
            report_type TEXT NOT NULL CHECK (report_type IN ('shifts', 'orders', 'transactions')),
            file_name TEXT NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            imported_by TEXT NOT NULL,
            imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS rezku_import_batches_created_idx ON rezku_import_batches (imported_at DESC);
CREATE TABLE IF NOT EXISTS rezku_shifts (
            id UUID PRIMARY KEY,
            source_key TEXT NOT NULL UNIQUE,
            batch_id UUID NOT NULL REFERENCES rezku_import_batches(id) ON DELETE CASCADE,
            employee_name TEXT NOT NULL,
            position TEXT NOT NULL DEFAULT '',
            role_group TEXT NOT NULL DEFAULT 'In-House',
            clock_in TIMESTAMPTZ,
            clock_out TIMESTAMPTZ,
            reported_hours NUMERIC(10,4) NOT NULL DEFAULT 0,
            raw JSONB NOT NULL DEFAULT '{}'::jsonb
          );
CREATE INDEX IF NOT EXISTS rezku_shifts_clock_idx ON rezku_shifts (clock_in, clock_out);
CREATE TABLE IF NOT EXISTS rezku_orders (
            id UUID PRIMARY KEY,
            source_key TEXT NOT NULL UNIQUE,
            batch_id UUID NOT NULL REFERENCES rezku_import_batches(id) ON DELETE CASCADE,
            order_id TEXT NOT NULL,
            opened_at TIMESTAMPTZ,
            order_type TEXT NOT NULL DEFAULT '',
            raw JSONB NOT NULL DEFAULT '{}'::jsonb
          );
CREATE INDEX IF NOT EXISTS rezku_orders_order_idx ON rezku_orders (order_id);
CREATE TABLE IF NOT EXISTS rezku_transactions (
            id UUID PRIMARY KEY,
            source_key TEXT NOT NULL UNIQUE,
            batch_id UUID NOT NULL REFERENCES rezku_import_batches(id) ON DELETE CASCADE,
            transaction_id TEXT NOT NULL DEFAULT '',
            order_id TEXT NOT NULL DEFAULT '',
            transaction_time TIMESTAMPTZ,
            tip NUMERIC(12,2) NOT NULL DEFAULT 0,
            raw JSONB NOT NULL DEFAULT '{}'::jsonb
          );
CREATE INDEX IF NOT EXISTS rezku_transactions_time_idx ON rezku_transactions (transaction_time);
CREATE TABLE IF NOT EXISTS accounting_accounts (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            account_type TEXT NOT NULL CHECK (account_type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            UNIQUE (business, code)
          );
CREATE TABLE IF NOT EXISTS journal_entries (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            entry_date DATE NOT NULL,
            description TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'Manual',
            reference TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS journal_entries_business_date_idx ON journal_entries (business, entry_date DESC);
CREATE TABLE IF NOT EXISTS journal_lines (
            id UUID PRIMARY KEY,
            entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
            account_id UUID NOT NULL REFERENCES accounting_accounts(id),
            debit NUMERIC(14,2) NOT NULL DEFAULT 0,
            credit NUMERIC(14,2) NOT NULL DEFAULT 0,
            CHECK (debit >= 0 AND credit >= 0),
            CHECK (NOT (debit > 0 AND credit > 0))
          );
CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines (entry_id);
CREATE TABLE IF NOT EXISTS integration_connections (
        id UUID PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('Plaid', 'Square', 'CSV')),
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        institution_name TEXT NOT NULL,
        external_item_id TEXT NOT NULL,
        encrypted_access_token TEXT NOT NULL DEFAULT '',
        encrypted_refresh_token TEXT NOT NULL DEFAULT '',
        token_expires_at TIMESTAMPTZ,
        cursor TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Active',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_sync_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (provider, external_item_id)
      );
CREATE INDEX IF NOT EXISTS integration_connections_business_idx ON integration_connections (business, provider, status);
CREATE TABLE IF NOT EXISTS bank_accounts (
        id UUID PRIMARY KEY,
        connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        external_account_id TEXT NOT NULL UNIQUE,
        institution_name TEXT NOT NULL,
        name TEXT NOT NULL,
        official_name TEXT NOT NULL DEFAULT '',
        mask TEXT NOT NULL DEFAULT '',
        account_type TEXT NOT NULL DEFAULT '',
        account_subtype TEXT NOT NULL DEFAULT '',
        current_balance NUMERIC(14,2),
        available_balance NUMERIC(14,2),
        currency TEXT NOT NULL DEFAULT 'USD',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS bank_accounts_business_idx ON bank_accounts (business, institution_name, active);
CREATE TABLE IF NOT EXISTS bank_transactions (
        id UUID PRIMARY KEY,
        connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        external_transaction_id TEXT NOT NULL UNIQUE,
        external_account_id TEXT NOT NULL DEFAULT '',
        transaction_date DATE NOT NULL,
        authorized_date DATE,
        merchant_name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        signed_amount NUMERIC(14,2) NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('Inflow', 'Outflow')),
        pending BOOLEAN NOT NULL DEFAULT FALSE,
        removed BOOLEAN NOT NULL DEFAULT FALSE,
        plaid_primary TEXT NOT NULL DEFAULT '',
        plaid_detail TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        account_code TEXT NOT NULL DEFAULT '',
        classification_source TEXT NOT NULL DEFAULT '',
        confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
        review_status TEXT NOT NULL DEFAULT 'Needs Review' CHECK (review_status IN ('Needs Review', 'Approved', 'Ignored')),
        user_override BOOLEAN NOT NULL DEFAULT FALSE,
        payment_channel TEXT NOT NULL DEFAULT '',
        check_number TEXT NOT NULL DEFAULT '',
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS bank_transactions_business_date_idx ON bank_transactions (business, transaction_date DESC);
CREATE INDEX IF NOT EXISTS bank_transactions_review_idx ON bank_transactions (business, review_status, transaction_date DESC);
CREATE TABLE IF NOT EXISTS classification_rules (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        priority INTEGER NOT NULL DEFAULT 100,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        direction TEXT NOT NULL DEFAULT 'Any' CHECK (direction IN ('Any', 'Inflow', 'Outflow')),
        field TEXT NOT NULL DEFAULT 'Either' CHECK (field IN ('Merchant', 'Description', 'Either')),
        match_type TEXT NOT NULL DEFAULT 'Contains' CHECK (match_type IN ('Contains', 'Exact')),
        pattern TEXT NOT NULL,
        category TEXT NOT NULL,
        account_code TEXT NOT NULL,
        confidence NUMERIC(5,4) NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS classification_rules_business_idx ON classification_rules (business, active, priority);
CREATE TABLE IF NOT EXISTS square_payments (
        id UUID PRIMARY KEY,
        connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        external_payment_id TEXT NOT NULL UNIQUE,
        business TEXT NOT NULL DEFAULT 'Tiki' CHECK (business = 'Tiki'),
        order_id TEXT NOT NULL DEFAULT '',
        location_id TEXT NOT NULL DEFAULT '',
        created_at_square TIMESTAMPTZ NOT NULL,
        updated_at_square TIMESTAMPTZ,
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        tip_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS square_payments_date_idx ON square_payments (created_at_square DESC);
CREATE TABLE IF NOT EXISTS integration_sync_runs (
        id UUID PRIMARY KEY,
        connection_id UUID REFERENCES integration_connections(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        status TEXT NOT NULL CHECK (status IN ('Running', 'Success', 'Failed', 'Skipped')),
        records_added INTEGER NOT NULL DEFAULT 0,
        records_modified INTEGER NOT NULL DEFAULT 0,
        records_removed INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
CREATE INDEX IF NOT EXISTS integration_sync_runs_created_idx ON integration_sync_runs (started_at DESC);
CREATE TABLE IF NOT EXISTS operation_issues (
        id UUID PRIMARY KEY,
        issue_key TEXT NOT NULL UNIQUE,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        issue_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'Warning' CHECK (severity IN ('Info', 'Warning', 'Error')),
        title TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        reference TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved', 'Ignored')),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
CREATE INDEX IF NOT EXISTS operation_issues_status_idx ON operation_issues (status, severity, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS payroll_runs (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        week_start DATE NOT NULL,
        week_end TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'Calculated' CHECK (status IN ('Calculated', 'Reviewed', 'Locked')),
        payload JSONB NOT NULL,
        generated_by TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (business, week_start)
      );
CREATE TABLE IF NOT EXISTS scheduler_runs (
        id UUID PRIMARY KEY,
        run_key TEXT NOT NULL UNIQUE,
        local_date DATE NOT NULL,
        local_hour INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('Running', 'Success', 'Failed', 'Skipped')),
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
CREATE TABLE IF NOT EXISTS square_orders (
        id UUID PRIMARY KEY,
        connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        external_order_id TEXT NOT NULL UNIQUE,
        location_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '',
        source_name TEXT NOT NULL DEFAULT '',
        created_at_square TIMESTAMPTZ,
        updated_at_square TIMESTAMPTZ,
        closed_at_square TIMESTAMPTZ,
        total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        tip_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE TABLE IF NOT EXISTS bank_transaction_splits (
        id UUID PRIMARY KEY,
        bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
        line_number INTEGER NOT NULL,
        account_code TEXT NOT NULL,
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        memo TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (bank_transaction_id, line_number)
      );
CREATE INDEX IF NOT EXISTS bank_transaction_splits_transaction_idx ON bank_transaction_splits (bank_transaction_id);
CREATE TABLE IF NOT EXISTS bank_transaction_postings (
        id UUID PRIMARY KEY,
        bank_transaction_id UUID NOT NULL UNIQUE REFERENCES bank_transactions(id) ON DELETE RESTRICT,
        journal_entry_id UUID NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
        posted_by TEXT NOT NULL,
        posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE TABLE IF NOT EXISTS bank_reconciliations (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        external_account_id TEXT NOT NULL,
        statement_start_date DATE NOT NULL,
        statement_end_date DATE NOT NULL,
        statement_beginning_balance NUMERIC(14,2) NOT NULL,
        statement_ending_balance NUMERIC(14,2) NOT NULL,
        cleared_activity NUMERIC(14,2) NOT NULL DEFAULT 0,
        difference NUMERIC(14,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Finalized', 'Reopened')),
        notes TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        finalized_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finalized_at TIMESTAMPTZ
      );
CREATE INDEX IF NOT EXISTS bank_reconciliations_business_idx ON bank_reconciliations (business, statement_end_date DESC);
CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
        reconciliation_id UUID NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
        bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (reconciliation_id, bank_transaction_id)
      );
CREATE INDEX IF NOT EXISTS bank_reconciliation_items_transaction_idx ON bank_reconciliation_items (bank_transaction_id);
CREATE TABLE IF NOT EXISTS square_deposit_matches (
        id UUID PRIMARY KEY,
        bank_transaction_id UUID NOT NULL UNIQUE REFERENCES bank_transactions(id) ON DELETE CASCADE,
        business TEXT NOT NULL DEFAULT 'Tiki' CHECK (business = 'Tiki'),
        square_gross NUMERIC(14,2) NOT NULL DEFAULT 0,
        square_fees NUMERIC(14,2) NOT NULL DEFAULT 0,
        square_net NUMERIC(14,2) NOT NULL DEFAULT 0,
        bank_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        variance NUMERIC(14,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Suggested' CHECK (status IN ('Suggested', 'Matched', 'Ignored')),
        matched_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        matched_at TIMESTAMPTZ
      );
CREATE TABLE IF NOT EXISTS square_deposit_match_payments (
        match_id UUID NOT NULL REFERENCES square_deposit_matches(id) ON DELETE CASCADE,
        square_payment_id UUID NOT NULL UNIQUE REFERENCES square_payments(id) ON DELETE RESTRICT,
        PRIMARY KEY (match_id, square_payment_id)
      );

-- src/lib/credential-resets.ts:ensureCredentialResetSchema
CREATE TABLE IF NOT EXISTS credential_reset_tokens (
            id UUID PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('app-password', 'employee-pin')),
            subject_id UUID NOT NULL,
            business TEXT CHECK (business IS NULL OR business IN ('Corner Deli', 'Tiki')),
            email TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            requested_ip TEXT NOT NULL DEFAULT '',
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS credential_reset_active_idx ON credential_reset_tokens (kind, email, expires_at DESC) WHERE used_at IS NULL;

-- src/lib/customer-display.ts:ensureCustomerDisplaySchema
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
          );
CREATE INDEX IF NOT EXISTS ordering_customers_business_name_idx ON ordering_customers (business, active, display_name);
CREATE TABLE IF NOT EXISTS ordering_customer_phones (
            id UUID PRIMARY KEY,
            customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
            normalized_phone TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            is_primary BOOLEAN NOT NULL DEFAULT FALSE,
            verified_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (customer_id, normalized_phone)
          );
CREATE INDEX IF NOT EXISTS ordering_customer_phones_lookup_idx ON ordering_customer_phones (normalized_phone);
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
          );
CREATE INDEX IF NOT EXISTS ordering_customer_addresses_customer_idx ON ordering_customer_addresses (customer_id, active);
CREATE TABLE IF NOT EXISTS ordering_menu_categories (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, name)
          );
CREATE INDEX IF NOT EXISTS ordering_menu_categories_business_idx ON ordering_menu_categories (business, active, sort_order, name);
ALTER TABLE ordering_menu_categories ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES ordering_menu_categories(id) ON DELETE SET NULL;
ALTER TABLE ordering_menu_categories ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_menu_categories ADD COLUMN IF NOT EXISTS presentation_only BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS ordering_menu_categories_parent_idx ON ordering_menu_categories (business, parent_id, active, sort_order, name);
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
          );
CREATE INDEX IF NOT EXISTS ordering_menu_items_business_category_idx ON ordering_menu_items (business, category_id, active, available, sort_order, name);
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
          );
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
          );
CREATE INDEX IF NOT EXISTS ordering_modifier_options_group_idx ON ordering_modifier_options (group_id, active, available, sort_order, name);
CREATE TABLE IF NOT EXISTS ordering_menu_item_modifier_groups (
            id UUID PRIMARY KEY,
            item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
            group_id UUID NOT NULL REFERENCES ordering_modifier_groups(id) ON DELETE CASCADE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (item_id, group_id)
          );
CREATE INDEX IF NOT EXISTS ordering_item_modifier_groups_item_idx ON ordering_menu_item_modifier_groups (item_id, sort_order);
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
          );
CREATE TABLE IF NOT EXISTS ordering_orders (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            source TEXT NOT NULL CHECK (source IN ('pos', 'web', 'ai_phone', 'kiosk', 'import')),
            customer_id UUID REFERENCES ordering_customers(id),
            caller_phone TEXT NOT NULL DEFAULT '',
            three_cx_call_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'sent_to_kitchen', 'in_progress', 'ready', 'completed', 'cancelled')),
            payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'failed')),
            payment_preference TEXT NOT NULL DEFAULT 'unspecified' CHECK (payment_preference IN ('unspecified', 'cash', 'card')),
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
          );
CREATE INDEX IF NOT EXISTS ordering_orders_business_created_idx ON ordering_orders (business, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_orders_customer_idx ON ordering_orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_orders_active_idx ON ordering_orders (business, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ordering_orders_3cx_call_idx ON ordering_orders (three_cx_call_id) WHERE three_cx_call_id <> '';
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
          );
CREATE INDEX IF NOT EXISTS ordering_order_items_order_idx ON ordering_order_items (order_id, sort_order, created_at);
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
          );
CREATE INDEX IF NOT EXISTS ordering_order_item_modifiers_item_idx ON ordering_order_item_modifiers (order_item_id, group_id);
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
          );
CREATE INDEX IF NOT EXISTS ordering_loyalty_ledger_balance_idx ON ordering_loyalty_ledger (program_id, customer_id, created_at);
CREATE INDEX IF NOT EXISTS ordering_loyalty_ledger_order_idx ON ordering_loyalty_ledger (order_id) WHERE order_id IS NOT NULL;
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
          );
CREATE INDEX IF NOT EXISTS ordering_upsell_rules_business_idx ON ordering_upsell_rules (business, active, priority DESC);
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
          );
CREATE INDEX IF NOT EXISTS ordering_call_sessions_active_idx ON ordering_call_sessions (business, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS ordering_call_sessions_phone_idx ON ordering_call_sessions (caller_phone, started_at DESC);
CREATE TABLE IF NOT EXISTS ordering_order_events (
            id UUID PRIMARY KEY,
            order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
            order_version INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            actor_type TEXT NOT NULL CHECK (actor_type IN ('ai', 'employee', 'customer', 'system', 'payment', 'web')),
            actor_id TEXT NOT NULL DEFAULT '',
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS ordering_order_events_order_idx ON ordering_order_events (order_id, order_version, created_at);
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
          );
CREATE INDEX IF NOT EXISTS ordering_customer_payment_methods_customer_idx ON ordering_customer_payment_methods (customer_id, business, active);
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
          );
CREATE INDEX IF NOT EXISTS ordering_payment_transactions_order_idx ON ordering_payment_transactions (order_id, created_at);
CREATE INDEX IF NOT EXISTS ordering_payment_transactions_customer_idx ON ordering_payment_transactions (customer_id, created_at DESC);
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_payment_transactions') AND c.conname = 'ordering_payment_transactions_tender_type_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:aac9b224cc8fcd320f11f37d081f0681'
  ) THEN
    ALTER TABLE ordering_payment_transactions DROP CONSTRAINT IF EXISTS ordering_payment_transactions_tender_type_check;
    ALTER TABLE ordering_payment_transactions ADD CONSTRAINT ordering_payment_transactions_tender_type_check CHECK (tender_type IN ('cash', 'card', 'gift_card', 'house_account', 'employee_meal', 'manager_comp', 'store_credit', 'other')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_payment_transactions_tender_type_check ON ordering_payment_transactions IS 'corner-ops:aac9b224cc8fcd320f11f37d081f0681';
    BEGIN
      ALTER TABLE ordering_payment_transactions VALIDATE CONSTRAINT ordering_payment_transactions_tender_type_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_payment_transactions_tender_type_check', 'ordering_payment_transactions';
    END;
  END IF;
END $mig$;
ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS client_mutation_id TEXT;
ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS check_id UUID;
ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS amount_tendered_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS change_due_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE ordering_payment_transactions ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS ordering_payment_transactions_idempotency_idx ON ordering_payment_transactions (business, client_mutation_id) WHERE client_mutation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_payment_transactions_provider_reference_idx ON ordering_payment_transactions (provider, provider_transaction_reference) WHERE provider <> '' AND provider_transaction_reference <> '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS paid_by TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS voided_by TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS void_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS pre_void_status TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS pre_void_payment_status TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS cancelled_quantity INTEGER NOT NULL DEFAULT 0;
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
          );
CREATE INDEX IF NOT EXISTS ordering_print_jobs_order_idx ON ordering_print_jobs (order_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ordering_print_jobs_payment_once_idx ON ordering_print_jobs (payment_transaction_id, purpose) WHERE payment_transaction_id IS NOT NULL AND is_reprint = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_print_jobs_kitchen_once_idx ON ordering_print_jobs (order_id, purpose) WHERE purpose = 'kitchen_production' AND is_reprint = FALSE;
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
          );
CREATE INDEX IF NOT EXISTS ordering_checks_order_idx ON ordering_checks(order_id, display_sequence);
CREATE TABLE IF NOT EXISTS ordering_check_line_assignments (
            check_id UUID NOT NULL REFERENCES ordering_checks(id) ON DELETE CASCADE,
            order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            allocated_cents INTEGER NOT NULL CHECK (allocated_cents >= 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(check_id, order_item_id)
          );
CREATE INDEX IF NOT EXISTS ordering_check_lines_item_idx ON ordering_check_line_assignments(order_item_id);
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_check_line_assignments') AND c.conname = 'ordering_check_line_assignments_order_item_id_fkey'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:59439c2bbfbb5ea5b1ffd82e103834cf'
  ) THEN
    ALTER TABLE ordering_check_line_assignments DROP CONSTRAINT IF EXISTS ordering_check_line_assignments_order_item_id_fkey;
    ALTER TABLE ordering_check_line_assignments ADD CONSTRAINT ordering_check_line_assignments_order_item_id_fkey FOREIGN KEY(order_item_id) REFERENCES ordering_order_items(id) ON DELETE CASCADE NOT VALID;
    COMMENT ON CONSTRAINT ordering_check_line_assignments_order_item_id_fkey ON ordering_check_line_assignments IS 'corner-ops:59439c2bbfbb5ea5b1ffd82e103834cf';
    BEGIN
      ALTER TABLE ordering_check_line_assignments VALIDATE CONSTRAINT ordering_check_line_assignments_order_item_id_fkey;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_check_line_assignments_order_item_id_fkey', 'ordering_check_line_assignments';
    END;
  END IF;
END $mig$;
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
          );
CREATE INDEX IF NOT EXISTS ordering_order_links_original_idx ON ordering_order_links (original_order_id, created_at);
CREATE INDEX IF NOT EXISTS ordering_order_links_related_idx ON ordering_order_links (related_order_id, created_at);
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
          );
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
          );
CREATE INDEX IF NOT EXISTS ordering_employee_meal_comps_employee_idx ON ordering_employee_meal_comps (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_employee_meal_comps_order_idx ON ordering_employee_meal_comps (order_id);
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
          );
CREATE INDEX IF NOT EXISTS ordering_house_accounts_business_idx ON ordering_house_accounts (business, status, name);
CREATE TABLE IF NOT EXISTS ordering_house_account_customers (
            id UUID PRIMARY KEY,
            account_id UUID NOT NULL REFERENCES ordering_house_accounts(id) ON DELETE CASCADE,
            customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
            can_charge BOOLEAN NOT NULL DEFAULT TRUE,
            label TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (account_id, customer_id)
          );
CREATE INDEX IF NOT EXISTS ordering_house_account_customers_customer_idx ON ordering_house_account_customers (customer_id, can_charge);
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
          );
CREATE INDEX IF NOT EXISTS ordering_house_account_ledger_account_idx ON ordering_house_account_ledger (account_id, created_at);
CREATE INDEX IF NOT EXISTS ordering_house_account_ledger_order_idx ON ordering_house_account_ledger (order_id) WHERE order_id IS NOT NULL;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_orders') AND c.conname = 'ordering_orders_service_type_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:72ffe2f618462aa30bcd9881428087a9'
  ) THEN
    ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_service_type_check;
    ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_service_type_check CHECK (service_type IN ('undecided','pickup','delivery','no_contact_delivery','dine_in','curbside','bar')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_orders_service_type_check ON ordering_orders IS 'corner-ops:72ffe2f618462aa30bcd9881428087a9';
    BEGIN
      ALTER TABLE ordering_orders VALIDATE CONSTRAINT ordering_orders_service_type_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_orders_service_type_check', 'ordering_orders';
    END;
  END IF;
END $mig$;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS sms_verified_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrival_status TEXT NOT NULL DEFAULT 'not_expected';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrival_acknowledged_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrival_details TEXT NOT NULL DEFAULT '';
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_orders') AND c.conname = 'ordering_orders_arrival_status_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:5caff34298c513cfb6dcb0fbed1f70ba'
  ) THEN
    ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_arrival_status_check;
    ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_arrival_status_check CHECK (arrival_status IN ('not_expected', 'waiting', 'arrived', 'acknowledged', 'completed')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_orders_arrival_status_check ON ordering_orders IS 'corner-ops:5caff34298c513cfb6dcb0fbed1f70ba';
    BEGIN
      ALTER TABLE ordering_orders VALIDATE CONSTRAINT ordering_orders_arrival_status_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_orders_arrival_status_check', 'ordering_orders';
    END;
  END IF;
END $mig$;
CREATE TABLE IF NOT EXISTS ordering_menu_item_modifier_defaults (
            id UUID PRIMARY KEY,
            item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
            option_id UUID NOT NULL REFERENCES ordering_modifier_options(id) ON DELETE CASCADE,
            default_selected BOOLEAN NOT NULL DEFAULT FALSE,
            included_quantity INTEGER NOT NULL DEFAULT 0 CHECK (included_quantity >= 0),
            price_delta_override_cents INTEGER,
            available_override BOOLEAN,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (item_id, option_id)
          );
ALTER TABLE ordering_menu_item_modifier_defaults ADD COLUMN IF NOT EXISTS available_override BOOLEAN;
CREATE INDEX IF NOT EXISTS ordering_item_modifier_defaults_idx ON ordering_menu_item_modifier_defaults (item_id, active);
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS selection_state TEXT NOT NULL DEFAULT 'selected';
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS pizza_topping_portion TEXT;
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS pizza_topping_amount TEXT;
ALTER TABLE ordering_order_item_modifiers DROP CONSTRAINT IF EXISTS ordering_order_item_modifiers_order_item_id_group_id_option_key;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_order_item_modifiers') AND c.conname = 'ordering_order_item_modifiers_pizza_topping_portion_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:ffb85fb6ffcd9e5865050a4b00210a32'
  ) THEN
    ALTER TABLE ordering_order_item_modifiers DROP CONSTRAINT IF EXISTS ordering_order_item_modifiers_pizza_topping_portion_check;
    ALTER TABLE ordering_order_item_modifiers ADD CONSTRAINT ordering_order_item_modifiers_pizza_topping_portion_check CHECK (pizza_topping_portion IS NULL OR pizza_topping_portion IN ('whole','left_half','right_half')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_order_item_modifiers_pizza_topping_portion_check ON ordering_order_item_modifiers IS 'corner-ops:ffb85fb6ffcd9e5865050a4b00210a32';
    BEGIN
      ALTER TABLE ordering_order_item_modifiers VALIDATE CONSTRAINT ordering_order_item_modifiers_pizza_topping_portion_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_order_item_modifiers_pizza_topping_portion_check', 'ordering_order_item_modifiers';
    END;
  END IF;
END $mig$;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_order_item_modifiers') AND c.conname = 'ordering_order_item_modifiers_pizza_topping_amount_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:9c12a8d94638dbd36ac07202da0a0f56'
  ) THEN
    ALTER TABLE ordering_order_item_modifiers DROP CONSTRAINT IF EXISTS ordering_order_item_modifiers_pizza_topping_amount_check;
    ALTER TABLE ordering_order_item_modifiers ADD CONSTRAINT ordering_order_item_modifiers_pizza_topping_amount_check CHECK (pizza_topping_amount IS NULL OR pizza_topping_amount IN ('regular','extra','double_extra','triple_extra')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_order_item_modifiers_pizza_topping_amount_check ON ordering_order_item_modifiers IS 'corner-ops:9c12a8d94638dbd36ac07202da0a0f56';
    BEGIN
      ALTER TABLE ordering_order_item_modifiers VALIDATE CONSTRAINT ordering_order_item_modifiers_pizza_topping_amount_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_order_item_modifiers_pizza_topping_amount_check', 'ordering_order_item_modifiers';
    END;
  END IF;
END $mig$;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_order_item_modifiers') AND c.conname = 'ordering_order_item_modifiers_selection_state_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:ac673638def14becfb52431e59cac3c1'
  ) THEN
    ALTER TABLE ordering_order_item_modifiers DROP CONSTRAINT IF EXISTS ordering_order_item_modifiers_selection_state_check;
    ALTER TABLE ordering_order_item_modifiers ADD CONSTRAINT ordering_order_item_modifiers_selection_state_check CHECK (selection_state IN ('selected', 'removed', 'extra', 'declined_included')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_order_item_modifiers_selection_state_check ON ordering_order_item_modifiers IS 'corner-ops:ac673638def14becfb52431e59cac3c1';
    BEGIN
      ALTER TABLE ordering_order_item_modifiers VALIDATE CONSTRAINT ordering_order_item_modifiers_selection_state_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_order_item_modifiers_selection_state_check', 'ordering_order_item_modifiers';
    END;
  END IF;
END $mig$;
CREATE TABLE IF NOT EXISTS ordering_combo_definitions (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            name TEXT NOT NULL,
            prompt TEXT NOT NULL DEFAULT '',
            base_price_delta_cents INTEGER NOT NULL DEFAULT 0 CHECK (base_price_delta_cents >= 0),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, name)
          );
CREATE TABLE IF NOT EXISTS ordering_menu_item_combos (
            id UUID PRIMARY KEY,
            item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
            combo_id UUID NOT NULL REFERENCES ordering_combo_definitions(id) ON DELETE CASCADE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (item_id, combo_id)
          );
CREATE INDEX IF NOT EXISTS ordering_menu_item_combos_item_idx ON ordering_menu_item_combos (item_id, active, sort_order);
CREATE TABLE IF NOT EXISTS ordering_combo_groups (
            id UUID PRIMARY KEY,
            combo_id UUID NOT NULL REFERENCES ordering_combo_definitions(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL DEFAULT '',
            min_selections INTEGER NOT NULL DEFAULT 1 CHECK (min_selections >= 0),
            max_selections INTEGER NOT NULL DEFAULT 1 CHECK (max_selections >= 1),
            sort_order INTEGER NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (max_selections >= min_selections),
            UNIQUE (combo_id, name)
          );
CREATE TABLE IF NOT EXISTS ordering_combo_options (
            id UUID PRIMARY KEY,
            group_id UUID NOT NULL REFERENCES ordering_combo_groups(id) ON DELETE CASCADE,
            menu_item_id UUID REFERENCES ordering_menu_items(id),
            name TEXT NOT NULL,
            price_delta_cents INTEGER NOT NULL DEFAULT 0,
            available BOOLEAN NOT NULL DEFAULT TRUE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (group_id, name)
          );
CREATE INDEX IF NOT EXISTS ordering_combo_options_group_idx ON ordering_combo_options (group_id, active, available, sort_order);
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS combo_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS combo_total_cents INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS ordering_order_item_combo_selections (
            id UUID PRIMARY KEY,
            order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
            combo_id UUID NOT NULL REFERENCES ordering_combo_definitions(id),
            group_id UUID NOT NULL REFERENCES ordering_combo_groups(id),
            option_id UUID NOT NULL REFERENCES ordering_combo_options(id),
            combo_name_snapshot TEXT NOT NULL,
            group_name_snapshot TEXT NOT NULL,
            option_name_snapshot TEXT NOT NULL,
            price_delta_cents INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (order_item_id, group_id, option_id)
          );
CREATE INDEX IF NOT EXISTS ordering_order_item_combo_idx ON ordering_order_item_combo_selections (order_item_id, group_id);
CREATE TABLE IF NOT EXISTS ordering_sms_verifications (
            id UUID PRIMARY KEY,
            order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
            phone TEXT NOT NULL,
            purpose TEXT NOT NULL DEFAULT 'unpaid_web_order' CHECK (purpose IN ('unpaid_web_order')),
            code_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'locked', 'invalidated')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
            max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
            resend_count INTEGER NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            verified_at TIMESTAMPTZ,
            invalidated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS ordering_sms_verifications_order_idx ON ordering_sms_verifications (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_sms_verifications_phone_idx ON ordering_sms_verifications (phone, created_at DESC);
CREATE TABLE IF NOT EXISTS ordering_inventory_locations (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            name TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, name)
          );
CREATE TABLE IF NOT EXISTS ordering_inventory_items (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            name TEXT NOT NULL,
            sku TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            base_unit TEXT NOT NULL DEFAULT 'each',
            estimated_unit_cost_cents INTEGER CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0),
            reorder_point NUMERIC(14,3),
            track_quantity BOOLEAN NOT NULL DEFAULT TRUE,
            allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, name),
            CHECK (reorder_point IS NULL OR reorder_point >= 0)
          );
CREATE INDEX IF NOT EXISTS ordering_inventory_items_business_idx ON ordering_inventory_items (business, active, category, name);
CREATE INDEX IF NOT EXISTS ordering_inventory_items_sku_idx ON ordering_inventory_items (business, sku) WHERE sku <> '';
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS par_quantity NUMERIC(14,3);
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS case_pack_quantity NUMERIC(14,3);
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS preferred_supplier TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS ordering_inventory_item_locations (
            id UUID PRIMARY KEY,
            inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id) ON DELETE CASCADE,
            location_id UUID NOT NULL REFERENCES ordering_inventory_locations(id) ON DELETE CASCADE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (inventory_item_id, location_id)
          );
CREATE TABLE IF NOT EXISTS ordering_inventory_movements (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),
            location_id UUID REFERENCES ordering_inventory_locations(id),
            delta_quantity NUMERIC(14,3) NOT NULL,
            unit TEXT NOT NULL,
            reason TEXT NOT NULL CHECK (reason IN (
              'sale',
              'received',
              'owner_use',
              'employee_use',
              'employee_meal',
              'damaged',
              'spilled',
              'spoilage',
              'waste',
              'theft_or_missing',
              'count_correction',
              'transfer_in',
              'transfer_out',
              'return_to_stock',
              'comp',
              'reversal',
              'other'
            )),
            order_id UUID REFERENCES ordering_orders(id),
            employee_id UUID REFERENCES employees(id),
            time_entry_id UUID REFERENCES time_entries(id),
            related_movement_id UUID REFERENCES ordering_inventory_movements(id),
            estimated_unit_cost_cents INTEGER CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0),
            note TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'pos',
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            CHECK (delta_quantity <> 0)
          );
CREATE INDEX IF NOT EXISTS ordering_inventory_movements_item_idx ON ordering_inventory_movements (inventory_item_id, created_at);
CREATE INDEX IF NOT EXISTS ordering_inventory_movements_business_reason_idx ON ordering_inventory_movements (business, reason, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_inventory_movements_employee_idx ON ordering_inventory_movements (employee_id, created_at DESC) WHERE employee_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ordering_inventory_counts (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),
            location_id UUID REFERENCES ordering_inventory_locations(id),
            expected_quantity NUMERIC(14,3) NOT NULL,
            counted_quantity NUMERIC(14,3) NOT NULL,
            variance_quantity NUMERIC(14,3) NOT NULL,
            adjustment_movement_id UUID REFERENCES ordering_inventory_movements(id),
            counted_by TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            counted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (expected_quantity >= 0),
            CHECK (counted_quantity >= 0),
            CHECK (variance_quantity = counted_quantity - expected_quantity)
          );
CREATE INDEX IF NOT EXISTS ordering_inventory_counts_item_idx ON ordering_inventory_counts (inventory_item_id, counted_at DESC);
ALTER TABLE ordering_inventory_counts DROP CONSTRAINT IF EXISTS ordering_inventory_counts_expected_quantity_check;
CREATE TABLE IF NOT EXISTS ordering_menu_inventory_links (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            menu_item_id UUID REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
            modifier_option_id UUID REFERENCES ordering_modifier_options(id) ON DELETE CASCADE,
            inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),
            quantity_used NUMERIC(14,3) NOT NULL CHECK (quantity_used > 0),
            unit TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK ((menu_item_id IS NOT NULL) <> (modifier_option_id IS NOT NULL))
          );
CREATE INDEX IF NOT EXISTS ordering_menu_inventory_links_menu_idx ON ordering_menu_inventory_links (menu_item_id, active) WHERE menu_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ordering_menu_inventory_links_modifier_idx ON ordering_menu_inventory_links (modifier_option_id, active) WHERE modifier_option_id IS NOT NULL;
ALTER TABLE ordering_inventory_movements ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES ordering_order_items(id);
ALTER TABLE ordering_inventory_movements ADD COLUMN IF NOT EXISTS inventory_link_id UUID REFERENCES ordering_menu_inventory_links(id);
CREATE UNIQUE INDEX IF NOT EXISTS ordering_inventory_sale_depletion_once ON ordering_inventory_movements(order_item_id,inventory_link_id) WHERE reason='sale' AND order_item_id IS NOT NULL AND inventory_link_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ordering_inventory_suppliers(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),name TEXT NOT NULL,contact_name TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',minimum_order_cents INTEGER NOT NULL DEFAULT 0,delivery_fee_cents INTEGER NOT NULL DEFAULT 0,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(business,name));
CREATE TABLE IF NOT EXISTS ordering_inventory_supplier_items(id UUID PRIMARY KEY,supplier_id UUID NOT NULL REFERENCES ordering_inventory_suppliers(id) ON DELETE CASCADE,inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id) ON DELETE CASCADE,vendor_sku TEXT NOT NULL DEFAULT '',case_quantity NUMERIC(14,3) NOT NULL DEFAULT 1,case_unit TEXT NOT NULL DEFAULT 'each',case_price_cents INTEGER NOT NULL DEFAULT 0,last_quoted_at TIMESTAMPTZ,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(supplier_id,inventory_item_id));
CREATE TABLE IF NOT EXISTS ordering_inventory_purchase_orders(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),supplier_id UUID NOT NULL REFERENCES ordering_inventory_suppliers(id),status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','ordered','partially_received','received','cancelled')),ordered_at TIMESTAMPTZ,received_at TIMESTAMPTZ,created_by TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ordering_inventory_purchase_order_lines(id UUID PRIMARY KEY,purchase_order_id UUID NOT NULL REFERENCES ordering_inventory_purchase_orders(id) ON DELETE CASCADE,inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),quantity_cases NUMERIC(14,3) NOT NULL CHECK(quantity_cases>0),case_quantity NUMERIC(14,3) NOT NULL CHECK(case_quantity>0),case_unit TEXT NOT NULL,case_price_cents INTEGER NOT NULL CHECK(case_price_cents>=0),received_cases NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(received_cases>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ordering_business_counters (
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            counter_name TEXT NOT NULL,
            next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (business, counter_name)
          );
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS display_number TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS payment_preference TEXT NOT NULL DEFAULT 'unspecified';
DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'ordering_orders_payment_preference_check'
            ) THEN
              ALTER TABLE ordering_orders
              ADD CONSTRAINT ordering_orders_payment_preference_check
              CHECK (payment_preference IN ('unspecified', 'cash', 'card'));
            END IF;
          END
          $$;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS held_until TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS table_label TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS guest_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS tax_exempt_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_orders_idempotency_idx ON ordering_orders (business, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ordering_orders_display_number_idx ON ordering_orders (business, display_number) WHERE display_number <> '';
CREATE UNIQUE INDEX IF NOT EXISTS ordering_orders_display_number_unique_idx ON ordering_orders (business, display_number) WHERE display_number <> '';
CREATE INDEX IF NOT EXISTS ordering_orders_scheduled_idx ON ordering_orders (business, scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS ordering_orders_kitchen_queue_idx ON ordering_orders (business, status, submitted_at) WHERE status IN ('sent_to_kitchen', 'in_progress', 'ready');
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
          );
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
          );
CREATE UNIQUE INDEX IF NOT EXISTS ordering_one_active_register_per_terminal ON ordering_register_sessions (terminal_id) WHERE status IN ('open', 'counting', 'needs_review');
CREATE INDEX IF NOT EXISTS ordering_register_sessions_business_idx ON ordering_register_sessions (business, opened_at DESC);
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
          );
CREATE INDEX IF NOT EXISTS ordering_cash_drawer_movements_session_idx ON ordering_cash_drawer_movements (register_session_id, created_at);
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
          );
CREATE INDEX IF NOT EXISTS ordering_driver_cash_settlements_driver_idx ON ordering_driver_cash_settlements (driver_employee_id, business_date DESC);
CREATE TABLE IF NOT EXISTS ordering_driver_cash_settlement_orders (
            id UUID PRIMARY KEY,
            settlement_id UUID NOT NULL REFERENCES ordering_driver_cash_settlements(id) ON DELETE CASCADE,
            order_id UUID NOT NULL REFERENCES ordering_orders(id),
            amount_due_cents INTEGER NOT NULL CHECK (amount_due_cents >= 0),
            cash_payment_transaction_id UUID REFERENCES ordering_payment_transactions(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (settlement_id, order_id)
          );
CREATE UNIQUE INDEX IF NOT EXISTS ordering_cash_order_once_per_posted_settlement ON ordering_driver_cash_settlement_orders (order_id) WHERE cash_payment_transaction_id IS NOT NULL;
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
          );
CREATE INDEX IF NOT EXISTS ordering_delivery_assignments_driver_idx ON ordering_delivery_assignments (driver_employee_id, status, assigned_at DESC);
CREATE INDEX IF NOT EXISTS ordering_delivery_assignments_order_idx ON ordering_delivery_assignments (order_id, assigned_at DESC);
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
          );
CREATE INDEX IF NOT EXISTS ordering_capacity_windows_lookup_idx ON ordering_capacity_windows (business, service_type, starts_at, ends_at);
CREATE TABLE IF NOT EXISTS ordering_order_capacity_usage (
            id UUID PRIMARY KEY,
            order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
            capacity_window_id UUID NOT NULL REFERENCES ordering_capacity_windows(id) ON DELETE CASCADE,
            points INTEGER NOT NULL DEFAULT 1 CHECK (points >= 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (order_id, capacity_window_id)
          );
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
          );
CREATE INDEX IF NOT EXISTS ordering_promotions_active_idx ON ordering_promotions (business, active, priority DESC);
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
          );
CREATE INDEX IF NOT EXISTS ordering_order_adjustments_order_idx ON ordering_order_adjustments (order_id, created_at);
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
          );
CREATE INDEX IF NOT EXISTS ordering_bar_tabs_open_idx ON ordering_bar_tabs (status, opened_at DESC);
CREATE TABLE IF NOT EXISTS ordering_bar_tab_orders (
            id UUID PRIMARY KEY,
            tab_id UUID NOT NULL REFERENCES ordering_bar_tabs(id) ON DELETE CASCADE,
            order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tab_id, order_id)
          );
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
          );
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
          );
CREATE INDEX IF NOT EXISTS ordering_gift_card_ledger_card_idx ON ordering_gift_card_ledger (gift_card_id, created_at);
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
          );
CREATE INDEX IF NOT EXISTS ordering_store_credit_customer_idx ON ordering_store_credit_ledger (business, customer_id, created_at);
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
          );
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
          );
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
          );
CREATE INDEX IF NOT EXISTS ordering_pos_audit_business_idx ON ordering_pos_audit_events (business, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_pos_audit_order_idx ON ordering_pos_audit_events (order_id, created_at) WHERE order_id IS NOT NULL;
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
          );
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_order_links') AND c.conname = 'ordering_order_links_relation_type_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:f5afa22e35761f7bed3609e4392d8c9d'
  ) THEN
    ALTER TABLE ordering_order_links DROP CONSTRAINT IF EXISTS ordering_order_links_relation_type_check;
    ALTER TABLE ordering_order_links ADD CONSTRAINT ordering_order_links_relation_type_check CHECK (relation_type IN ( 'add_on', 'payment_followup', 'replacement', 'complaint_remake', 'split', 'merge', 'reopen', 'duplicate', 'other' )) NOT VALID;
    COMMENT ON CONSTRAINT ordering_order_links_relation_type_check ON ordering_order_links IS 'corner-ops:f5afa22e35761f7bed3609e4392d8c9d';
    BEGIN
      ALTER TABLE ordering_order_links VALIDATE CONSTRAINT ordering_order_links_relation_type_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_order_links_relation_type_check', 'ordering_order_links';
    END;
  END IF;
END $mig$;
CREATE TABLE IF NOT EXISTS ordering_hardware_locations (
        id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        name TEXT NOT NULL, location_key TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(business,location_key), UNIQUE(business,name)
      );
CREATE TABLE IF NOT EXISTS ordering_hardware_devices (
        id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        location_id UUID NOT NULL REFERENCES ordering_hardware_locations(id), name TEXT NOT NULL,
        device_key TEXT NOT NULL, device_type TEXT NOT NULL CHECK(device_type IN ('printer','payment_terminal','barcode_scanner')),
        role TEXT NOT NULL CHECK(role IN ('receipt_printer','kitchen_printer','payment_terminal','barcode_scanner')),
        station_key TEXT NOT NULL DEFAULT '', adapter_key TEXT NOT NULL DEFAULT 'unconfigured',
        adapter_config JSONB NOT NULL DEFAULT '{}'::jsonb, active BOOLEAN NOT NULL DEFAULT TRUE,
        reported_status TEXT NOT NULL DEFAULT 'unknown' CHECK(reported_status IN ('online','offline','unknown')),
        last_seen_at TIMESTAMPTZ, status_message TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(business,device_key), UNIQUE(location_id,name)
      );
ALTER TABLE ordering_hardware_devices DROP CONSTRAINT IF EXISTS ordering_hardware_devices_role_check;
ALTER TABLE ordering_hardware_devices ADD CONSTRAINT ordering_hardware_devices_role_check CHECK(role IN ('receipt_printer','kitchen_printer','label_printer','payment_terminal','barcode_scanner'));
CREATE INDEX IF NOT EXISTS ordering_hardware_devices_scope_idx ON ordering_hardware_devices(business,location_id,device_type,active);
CREATE TABLE IF NOT EXISTS ordering_payment_stations (
        id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        name TEXT NOT NULL, station_key TEXT NOT NULL, station_mode TEXT NOT NULL DEFAULT 'order_taker' CHECK(station_mode IN ('payment','order_taker')),
        receipt_printer_id UUID REFERENCES ordering_hardware_devices(id), payment_terminal_id UUID REFERENCES ordering_hardware_devices(id),
        gift_card_reader_id UUID REFERENCES ordering_hardware_devices(id), active BOOLEAN NOT NULL DEFAULT TRUE,
        phone_card_payments_enabled BOOLEAN NOT NULL DEFAULT FALSE, customer_display_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        shared_register_key TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(business,station_key), UNIQUE(business,name)
      );
ALTER TABLE ordering_payment_stations ADD COLUMN IF NOT EXISTS phone_card_payments_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_payment_stations ADD COLUMN IF NOT EXISTS customer_display_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_payment_stations ADD COLUMN IF NOT EXISTS shared_register_key TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS ordering_one_payment_station_idx ON ordering_payment_stations(business) WHERE station_mode='payment' AND active=TRUE;
CREATE TABLE IF NOT EXISTS ordering_payment_station_queue (
        id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')), order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
        check_id UUID REFERENCES ordering_checks(id) ON DELETE CASCADE, source_station_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','completed','cancelled')),
        requested_by TEXT NOT NULL, claimed_by TEXT NOT NULL DEFAULT '', request_note TEXT NOT NULL DEFAULT '',
        queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ
      );
CREATE UNIQUE INDEX IF NOT EXISTS ordering_payment_station_queue_active_idx ON ordering_payment_station_queue(business,order_id,COALESCE(check_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('queued','claimed');
CREATE INDEX IF NOT EXISTS ordering_payment_station_queue_status_idx ON ordering_payment_station_queue(business,status,queued_at);
CREATE TABLE IF NOT EXISTS ordering_printer_routes (
        id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        location_id UUID NOT NULL REFERENCES ordering_hardware_locations(id), printer_id UUID NOT NULL REFERENCES ordering_hardware_devices(id),
        target_type TEXT NOT NULL CHECK(target_type IN ('all','item','category','station')),
        target_id TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(business,location_id,target_type,target_id,printer_id)
      );
ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES ordering_hardware_locations(id);
ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES ordering_hardware_devices(id);
ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES ordering_print_jobs(id);
ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
DROP INDEX IF EXISTS ordering_print_jobs_kitchen_once_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_print_jobs_kitchen_once_idx ON ordering_print_jobs (order_id, purpose) WHERE purpose = 'kitchen_production' AND is_reprint = FALSE AND parent_job_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_print_jobs_idempotency_idx ON ordering_print_jobs(business,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ordering_print_jobs_queue_idx ON ordering_print_jobs(business,status,queued_at DESC);
CREATE TABLE IF NOT EXISTS ordering_order_delivery_addresses (
          order_id UUID PRIMARY KEY REFERENCES ordering_orders(id) ON DELETE CASCADE,
          entered_address TEXT NOT NULL, formatted_address TEXT NOT NULL, line1 TEXT NOT NULL,
          line2 TEXT NOT NULL DEFAULT '', city TEXT NOT NULL, state TEXT NOT NULL,
          postal_code TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'US', latitude NUMERIC(10,7) NOT NULL,
          longitude NUMERIC(10,7) NOT NULL, provider TEXT NOT NULL, provider_reference_id TEXT NOT NULL DEFAULT '',
          validation_status TEXT NOT NULL CHECK (validation_status IN ('validated')),
          validated_at TIMESTAMPTZ NOT NULL, route_distance_miles NUMERIC(7,2),
          route_duration_seconds INTEGER, route_provider TEXT NOT NULL DEFAULT '', route_calculated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
ALTER TABLE ordering_order_delivery_addresses ADD COLUMN IF NOT EXISTS delivery_notes_snapshot TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS ordering_menu_item_variants (
            id UUID PRIMARY KEY,
            item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            sku TEXT NOT NULL DEFAULT '',
            base_price_cents INTEGER NOT NULL CHECK (base_price_cents >= 0),
            default_variant BOOLEAN NOT NULL DEFAULT FALSE,
            available BOOLEAN NOT NULL DEFAULT TRUE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (item_id, name)
          );
ALTER TABLE ordering_menu_item_variants ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS ordering_menu_item_variants_item_idx ON ordering_menu_item_variants (item_id, active, available, sort_order, name);
CREATE UNIQUE INDEX IF NOT EXISTS ordering_menu_item_one_default_variant_idx
          ON ordering_menu_item_variants (item_id)
          WHERE default_variant = TRUE AND active = TRUE;
CREATE TABLE IF NOT EXISTS ordering_menu_variant_aliases (
            id UUID PRIMARY KEY,
            variant_id UUID NOT NULL REFERENCES ordering_menu_item_variants(id) ON DELETE CASCADE,
            alias TEXT NOT NULL,
            normalized_alias TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (variant_id, normalized_alias)
          );
CREATE INDEX IF NOT EXISTS ordering_menu_variant_aliases_lookup_idx ON ordering_menu_variant_aliases (normalized_alias, active);
CREATE TABLE IF NOT EXISTS ordering_menu_item_aliases (
            id UUID PRIMARY KEY,
            item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
            alias TEXT NOT NULL,
            normalized_alias TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (item_id, normalized_alias)
          );
CREATE INDEX IF NOT EXISTS ordering_menu_item_aliases_lookup_idx ON ordering_menu_item_aliases (normalized_alias, active);
CREATE TABLE IF NOT EXISTS ordering_menu_variant_modifier_prices (
            id UUID PRIMARY KEY,
            variant_id UUID NOT NULL REFERENCES ordering_menu_item_variants(id) ON DELETE CASCADE,
            option_id UUID NOT NULL REFERENCES ordering_modifier_options(id) ON DELETE CASCADE,
            price_delta_cents INTEGER NOT NULL DEFAULT 0,
            available BOOLEAN NOT NULL DEFAULT TRUE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (variant_id, option_id)
          );
CREATE INDEX IF NOT EXISTS ordering_variant_modifier_prices_lookup_idx ON ordering_menu_variant_modifier_prices (variant_id, option_id, active);
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES ordering_menu_item_variants(id);
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS variant_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS variant_sku_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_modifier_groups DROP CONSTRAINT IF EXISTS ordering_modifier_groups_business_name_key;
CREATE INDEX IF NOT EXISTS ordering_modifier_groups_business_name_idx ON ordering_modifier_groups (business, name);
CREATE TABLE IF NOT EXISTS ordering_menu_import_runs (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            source TEXT NOT NULL CHECK (source IN ('rezku', 'csv', 'json', 'manual')),
            source_url TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'approved', 'applied', 'failed', 'cancelled')),
            category_count INTEGER NOT NULL DEFAULT 0 CHECK (category_count >= 0),
            item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
            modifier_group_count INTEGER NOT NULL DEFAULT 0 CHECK (modifier_group_count >= 0),
            modifier_option_count INTEGER NOT NULL DEFAULT 0 CHECK (modifier_option_count >= 0),
            warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
            snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by TEXT NOT NULL,
            approved_by TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            approved_at TIMESTAMPTZ,
            applied_at TIMESTAMPTZ,
            error_message TEXT NOT NULL DEFAULT ''
          );
ALTER TABLE ordering_menu_import_runs ADD COLUMN IF NOT EXISTS variant_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_menu_import_runs ADD COLUMN IF NOT EXISTS variant_modifier_price_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS ordering_menu_source_map (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            source TEXT NOT NULL CHECK (source IN ('rezku', 'csv', 'json', 'manual')),
            entity_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            internal_id UUID NOT NULL,
            source_hash TEXT NOT NULL DEFAULT '',
            source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            last_import_run_id UUID REFERENCES ordering_menu_import_runs(id) ON DELETE SET NULL,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, source, entity_type, source_id)
          );
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_menu_source_map') AND c.conname = 'ordering_menu_source_map_entity_type_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:5fb9c23a83328cbf648a54707ef09477'
  ) THEN
    ALTER TABLE ordering_menu_source_map DROP CONSTRAINT IF EXISTS ordering_menu_source_map_entity_type_check;
    ALTER TABLE ordering_menu_source_map ADD CONSTRAINT ordering_menu_source_map_entity_type_check CHECK (entity_type IN ( 'category', 'item', 'variant', 'modifier_group', 'modifier_option', 'variant_modifier_price', 'combo', 'combo_group', 'combo_option' )) NOT VALID;
    COMMENT ON CONSTRAINT ordering_menu_source_map_entity_type_check ON ordering_menu_source_map IS 'corner-ops:5fb9c23a83328cbf648a54707ef09477';
    BEGIN
      ALTER TABLE ordering_menu_source_map VALIDATE CONSTRAINT ordering_menu_source_map_entity_type_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_menu_source_map_entity_type_check', 'ordering_menu_source_map';
    END;
  END IF;
END $mig$;
CREATE INDEX IF NOT EXISTS ordering_menu_source_map_internal_idx ON ordering_menu_source_map (entity_type, internal_id);
CREATE TABLE IF NOT EXISTS ordering_category_overrides (
        category_id UUID PRIMARY KEY REFERENCES ordering_menu_categories(id) ON DELETE CASCADE,
        display_name TEXT, parent_id UUID REFERENCES ordering_menu_categories(id), sort_order INTEGER,
        parent_id_overridden BOOLEAN NOT NULL DEFAULT FALSE, visible BOOLEAN,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT NOT NULL DEFAULT ''
      );
ALTER TABLE ordering_category_overrides ADD COLUMN IF NOT EXISTS parent_id_overridden BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS ordering_item_overrides (
        item_id UUID PRIMARY KEY REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
        display_name TEXT, category_id UUID REFERENCES ordering_menu_categories(id), sort_order INTEGER,
        visible BOOLEAN, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT NOT NULL DEFAULT ''
      );
ALTER TABLE ordering_item_overrides ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE ordering_item_overrides ADD COLUMN IF NOT EXISTS print_name TEXT;
CREATE TABLE IF NOT EXISTS ordering_category_channel_overrides (category_id UUID NOT NULL REFERENCES ordering_menu_categories(id) ON DELETE CASCADE,channel TEXT NOT NULL CHECK(channel IN ('pos','web')),display_name TEXT,parent_id UUID REFERENCES ordering_menu_categories(id),parent_id_overridden BOOLEAN NOT NULL DEFAULT FALSE,sort_order INTEGER,visible BOOLEAN,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL DEFAULT '',PRIMARY KEY(category_id,channel));
CREATE TABLE IF NOT EXISTS ordering_item_channel_overrides (item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,channel TEXT NOT NULL CHECK(channel IN ('pos','web')),display_name TEXT,category_id UUID REFERENCES ordering_menu_categories(id),sort_order INTEGER,visible BOOLEAN,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL DEFAULT '',PRIMARY KEY(item_id,channel));
ALTER TABLE ordering_item_channel_overrides ADD COLUMN IF NOT EXISTS description TEXT;
CREATE TABLE IF NOT EXISTS ordering_item_variant_print_overrides(variant_id UUID PRIMARY KEY REFERENCES ordering_menu_item_variants(id) ON DELETE CASCADE,print_name TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS ordering_modifier_option_print_overrides(option_id UUID PRIMARY KEY REFERENCES ordering_modifier_options(id) ON DELETE CASCADE,print_name TEXT,print_order INTEGER,print_section TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL DEFAULT '');
ALTER TABLE ordering_modifier_option_print_overrides ADD COLUMN IF NOT EXISTS suppress_when_default BOOLEAN;
ALTER TABLE ordering_modifier_option_print_overrides ADD COLUMN IF NOT EXISTS print_only_when_changed BOOLEAN;
CREATE TABLE IF NOT EXISTS ordering_menu_media (id UUID PRIMARY KEY,target_type TEXT NOT NULL CHECK(target_type IN ('item','modifier_option')),target_id UUID NOT NULL,storage_reference TEXT NOT NULL,alt_text TEXT NOT NULL DEFAULT '',mime_type TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,size_bytes INTEGER NOT NULL,is_primary BOOLEAN NOT NULL DEFAULT TRUE,show_pos BOOLEAN NOT NULL DEFAULT TRUE,show_web BOOLEAN NOT NULL DEFAULT TRUE,uploaded_by TEXT NOT NULL,uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ordering_modifier_presentation_overrides (
        item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
        group_id UUID NOT NULL REFERENCES ordering_modifier_groups(id) ON DELETE CASCADE,
        context TEXT CHECK (context IN ('ordinary','combo_trigger','dependent','hidden')),
        behavior TEXT CHECK (behavior IN ('standard','pizza_topping')),
        included_choice_count INTEGER,
        parent_group_id UUID REFERENCES ordering_modifier_groups(id),
        parent_option_ids UUID[], sort_order INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL DEFAULT '', PRIMARY KEY (item_id, group_id)
      );
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS behavior TEXT;
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS included_choice_count INTEGER;
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS supports_intensity BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS print_order INTEGER;
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS header_modifier BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS suppress_default_on_ticket BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS presentation_style TEXT NOT NULL DEFAULT 'grid';
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS component_key TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS component_label TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS component_order INTEGER;
ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS dependency_scope TEXT NOT NULL DEFAULT 'item';
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS item_print_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS option_print_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS print_order_snapshot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS header_modifier_snapshot BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS ordering_menu_override_audit (
        id UUID PRIMARY KEY, business TEXT NOT NULL, actor_id TEXT NOT NULL, target_type TEXT NOT NULL,
        target_id UUID NOT NULL, field_name TEXT NOT NULL, previous_value JSONB, new_value JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS ordering_menu_override_audit_target_idx ON ordering_menu_override_audit(target_type,target_id,created_at DESC);
ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS merged_into_customer_id UUID REFERENCES ordering_customers(id);
ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS last_order_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS ordering_customer_emails (
          id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          normalized_email TEXT NOT NULL, display_email TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'Email',
          is_primary BOOLEAN NOT NULL DEFAULT FALSE, verified_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(customer_id,normalized_email)
        );
CREATE INDEX IF NOT EXISTS ordering_customer_emails_lookup_idx ON ordering_customer_emails(normalized_email);
INSERT INTO ordering_customer_emails(id,customer_id,normalized_email,display_email,is_primary)
          SELECT gen_random_uuid(),id,lower(trim(email)),trim(email),TRUE FROM ordering_customers customer
          WHERE trim(email)<>'' AND NOT EXISTS(SELECT 1 FROM ordering_customer_emails existing WHERE existing.customer_id=customer.id AND existing.normalized_email=lower(trim(customer.email)));
WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY created_at,id) position FROM ordering_customer_emails WHERE is_primary=TRUE) UPDATE ordering_customer_emails email SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE email.id=ranked.id AND ranked.position>1;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_customer_emails_one_primary_idx ON ordering_customer_emails(customer_id) WHERE is_primary=TRUE;
ALTER TABLE ordering_customer_phones ADD COLUMN IF NOT EXISTS display_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_customer_phones ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE ordering_customer_phones ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS standardized_address TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS provider_reference_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);
ALTER TABLE ordering_customer_addresses ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS first_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS last_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS phone_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS email_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS order_origin TEXT NOT NULL DEFAULT 'pos';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS customer_phone_id UUID REFERENCES ordering_customer_phones(id) ON DELETE SET NULL;
ALTER TABLE ordering_order_delivery_addresses ADD COLUMN IF NOT EXISTS customer_address_id UUID REFERENCES ordering_customer_addresses(id);
CREATE INDEX IF NOT EXISTS ordering_orders_customer_search_idx ON ordering_orders (business, created_at DESC, payment_status);
CREATE INDEX IF NOT EXISTS ordering_customers_merged_idx ON ordering_customers (business, merged_into_customer_id);
CREATE INDEX IF NOT EXISTS ordering_customer_phones_customer_active_idx ON ordering_customer_phones (customer_id, is_primary DESC, last_used_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS ordering_customer_emails_customer_idx ON ordering_customer_emails(customer_id,is_primary DESC,created_at);
CREATE TABLE IF NOT EXISTS ordering_crm_import_batches(
          id UUID PRIMARY KEY,business TEXT NOT NULL,file_name TEXT NOT NULL,file_hash TEXT NOT NULL,
          source_rows INTEGER NOT NULL,customer_groups INTEGER NOT NULL,created_customers INTEGER NOT NULL DEFAULT 0,
          updated_customers INTEGER NOT NULL DEFAULT 0,merged_customers INTEGER NOT NULL DEFAULT 0,
          imported_by TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(business,file_hash)
        );
CREATE INDEX IF NOT EXISTS ordering_orders_customer_phone_idx ON ordering_orders (customer_phone_id);
WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY created_at,id) position FROM ordering_customer_phones WHERE is_primary=TRUE) UPDATE ordering_customer_phones phone SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE phone.id=ranked.id AND ranked.position>1;
WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY last_used_at DESC NULLS LAST,created_at,id) position FROM ordering_customer_addresses WHERE is_primary=TRUE AND active=TRUE) UPDATE ordering_customer_addresses address SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE address.id=ranked.id AND ranked.position>1;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_customer_phones_one_primary_idx ON ordering_customer_phones (customer_id) WHERE is_primary=TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_customer_addresses_one_primary_idx ON ordering_customer_addresses (customer_id) WHERE is_primary=TRUE AND active=TRUE;
CREATE TABLE IF NOT EXISTS ordering_business_settings (
          business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
          pos_idle_lock_seconds INTEGER NOT NULL DEFAULT 60 CHECK (pos_idle_lock_seconds = 0 OR pos_idle_lock_seconds BETWEEN 15 AND 3600),
          online_order_alert_sound TEXT NOT NULL DEFAULT 'warm_chime',
          online_order_alert_volume INTEGER NOT NULL DEFAULT 65,
          business_timezone TEXT NOT NULL DEFAULT 'America/New_York',
          updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
ALTER TABLE ordering_business_settings ADD COLUMN IF NOT EXISTS online_order_alert_sound TEXT NOT NULL DEFAULT 'warm_chime';
ALTER TABLE ordering_business_settings ADD COLUMN IF NOT EXISTS online_order_alert_volume INTEGER NOT NULL DEFAULT 65;
CREATE TABLE IF NOT EXISTS ordering_customer_merge_events (
          id UUID PRIMARY KEY, business TEXT NOT NULL, surviving_customer_id UUID NOT NULL REFERENCES ordering_customers(id),
          merged_customer_id UUID NOT NULL REFERENCES ordering_customers(id), actor_id TEXT NOT NULL,
          field_choices JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (surviving_customer_id <> merged_customer_id)
        );
CREATE INDEX IF NOT EXISTS ordering_customer_merge_events_customer_idx ON ordering_customer_merge_events (surviving_customer_id, created_at DESC);
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS amount TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS was_default_selected_snapshot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS default_amount_snapshot TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS print_on_ticket BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS ordering_customer_display_sessions (
        business TEXT NOT NULL, station_key TEXT NOT NULL, order_id UUID REFERENCES ordering_orders(id) ON DELETE SET NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb, response JSONB NOT NULL DEFAULT '{}'::jsonb,
        response_version INTEGER NOT NULL DEFAULT 0, response_handled_version INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '12 hours',
        PRIMARY KEY (business, station_key)
      );
CREATE TABLE IF NOT EXISTS ordering_customer_checkout_responses (
        id UUID PRIMARY KEY, business TEXT NOT NULL, station_key TEXT NOT NULL, order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
        response_type TEXT NOT NULL CHECK(response_type IN ('tip','signature','receipt')),
        details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS ordering_customer_checkout_response_order_idx ON ordering_customer_checkout_responses(order_id,created_at);

-- src/lib/customer-ordering-schema.ts:ensureCustomerOrderingSchema
CREATE TABLE IF NOT EXISTS ordering_customer_web_sessions (
        session_hash TEXT PRIMARY KEY,
        customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
        authenticated_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE TABLE IF NOT EXISTS ordering_customer_web_carts (
        order_id UUID PRIMARY KEY REFERENCES ordering_orders(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES ordering_customer_web_sessions(session_hash) ON DELETE CASCADE,
        replaced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS ordering_customer_web_carts_session_idx ON ordering_customer_web_carts(session_hash,created_at DESC);
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS confirmation_email_error TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS ordering_customer_identities (
          id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          provider TEXT NOT NULL, provider_subject TEXT NOT NULL, email TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(provider,provider_subject)
        );
CREATE UNIQUE INDEX IF NOT EXISTS ordering_customer_identity_email_idx ON ordering_customer_identities(provider,email);
CREATE TABLE IF NOT EXISTS ordering_customer_email_codes (
          id UUID PRIMARY KEY,email TEXT NOT NULL,code_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
          used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
CREATE INDEX IF NOT EXISTS ordering_customer_email_codes_lookup_idx ON ordering_customer_email_codes(email,created_at DESC);
CREATE TABLE IF NOT EXISTS ordering_customer_phone_codes (
          id UUID PRIMARY KEY,customer_id UUID NOT NULL REFERENCES ordering_customers(id) ON DELETE CASCADE,
          normalized_phone TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
CREATE INDEX IF NOT EXISTS ordering_customer_phone_codes_lookup_idx ON ordering_customer_phone_codes(customer_id,normalized_phone,created_at DESC);
CREATE TABLE IF NOT EXISTS ordering_customer_login_phone_codes (
          id UUID PRIMARY KEY,normalized_phone TEXT NOT NULL,customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
          code_hash TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
          used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
CREATE INDEX IF NOT EXISTS ordering_customer_login_phone_codes_lookup_idx ON ordering_customer_login_phone_codes(normalized_phone,created_at DESC);

-- src/lib/delivery-boy/server.ts:ensureDeliverySchema
CREATE TABLE IF NOT EXISTS delivery_boy_runs(id UUID PRIMARY KEY,token_hash TEXT NOT NULL,player_name TEXT NOT NULL DEFAULT 'Anonymous Driver',status TEXT NOT NULL DEFAULT 'active',stage INTEGER NOT NULL DEFAULT 1,sequence INTEGER NOT NULL DEFAULT 0,active_seconds INTEGER NOT NULL DEFAULT 0,score INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0,missed INTEGER NOT NULL DEFAULT 0,hits INTEGER NOT NULL DEFAULT 0,checkpoints JSONB NOT NULL DEFAULT '[]'::jsonb,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ);
ALTER TABLE delivery_boy_runs ADD COLUMN IF NOT EXISTS game_version TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE IF NOT EXISTS delivery_boy_rewards(id UUID PRIMARY KEY,run_id UUID NOT NULL UNIQUE REFERENCES delivery_boy_runs(id),code TEXT NOT NULL UNIQUE,prize_type TEXT NOT NULL,terms JSONB NOT NULL,completion_stats JSONB NOT NULL,issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ,redeemed_at TIMESTAMPTZ,redeemed_by TEXT,redemption_note TEXT NOT NULL DEFAULT '');

-- src/lib/direct-deposit.ts:ensureDirectDepositSchema
CREATE TABLE IF NOT EXISTS direct_deposit_elections (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_id UUID NOT NULL REFERENCES employees(id),
            employee_name TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('Assigned', 'Completed', 'Superseded')),
            encrypted_payload TEXT NOT NULL,
            assigned_by TEXT NOT NULL,
            assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            employee_signature_name TEXT NOT NULL DEFAULT '',
            signed_at TIMESTAMPTZ,
            signature_ip TEXT NOT NULL DEFAULT '',
            signature_user_agent TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS direct_deposit_employee_idx ON direct_deposit_elections (employee_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS direct_deposit_business_status_idx ON direct_deposit_elections (business, status, assigned_at DESC);

-- src/lib/door-chime.ts:ensureDoorChimeSchema
CREATE TABLE IF NOT EXISTS door_chime_events (
            id BIGSERIAL PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            camera TEXT NOT NULL DEFAULT 'entrance',
            kind TEXT NOT NULL DEFAULT 'person',
            detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS idx_door_chime_events_recent ON door_chime_events (business, detected_at DESC);

-- src/lib/employee-directory.ts:ensureEmployeeDirectorySchema
ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS employees_business_email_unique
          ON employees (business, LOWER(email))
          WHERE email <> '';
CREATE OR REPLACE FUNCTION corner_ops_prepare_rezku_employee()
          RETURNS TRIGGER
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.employee_name IS NULL OR BTRIM(NEW.employee_name) = '' THEN
              RETURN NEW;
            END IF;
  
            IF LOWER(BTRIM(NEW.employee_name)) = 'cover' THEN
              RETURN NULL;
            END IF;
  
            IF LOWER(BTRIM(NEW.employee_name)) = 'can' THEN
              NEW.employee_name := 'Ken';
            END IF;
  
            RETURN NEW;
          END;
          $$;
DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_trigger
              WHERE tgname = 'rezku_employee_alias_normalization'
                AND tgrelid = 'rezku_shifts'::regclass
                AND NOT tgisinternal
            ) THEN
              CREATE TRIGGER rezku_employee_alias_normalization
              BEFORE INSERT OR UPDATE OF employee_name
              ON rezku_shifts
              FOR EACH ROW
              EXECUTE FUNCTION corner_ops_prepare_rezku_employee();
            END IF;
          EXCEPTION WHEN duplicate_object THEN NULL;
          END;
          $$;
CREATE OR REPLACE FUNCTION corner_ops_sync_rezku_employee()
          RETURNS TRIGGER
          LANGUAGE plpgsql
          AS $$
          DECLARE
            canonical_name TEXT;
            employee_position TEXT;
            employee_role TEXT;
          BEGIN
            canonical_name := BTRIM(COALESCE(NEW.employee_name, ''));
            IF canonical_name = '' OR LOWER(canonical_name) = 'cover' THEN
              RETURN NEW;
            END IF;
            IF LOWER(canonical_name) = 'can' THEN
              canonical_name := 'Ken';
            END IF;
  
            employee_position := COALESCE(NULLIF(BTRIM(NEW.position), ''), 'Employee');
            employee_role := CASE
              WHEN NEW.role_group IN ('Driver', 'In-House', 'Ignore') THEN NEW.role_group
              WHEN LOWER(employee_position) ~ '(driver|deliver)' THEN 'Driver'
              WHEN LOWER(employee_position) ~ '(training|trainee)' THEN 'Ignore'
              ELSE 'In-House'
            END;
  
            UPDATE employees
            SET
              position = employee_position,
              role_group = employee_role,
              counts_for_tips = employee_role <> 'Ignore',
              updated_at = NOW()
            WHERE business = 'Corner Deli'
              AND LOWER(BTRIM(name)) = LOWER(canonical_name);
  
            IF NOT FOUND THEN
              INSERT INTO employees (
                id, business, email, name, pin_hash, pin_enabled, position,
                role_group, counts_for_tips, hourly_rate, tipped_rate, active
              ) VALUES (
                gen_random_uuid(), 'Corner Deli', '', canonical_name,
                'rezku:' || MD5(LOWER(canonical_name)), FALSE,
                employee_position, employee_role, employee_role <> 'Ignore', 0, 0, TRUE
              );
            END IF;
  
            RETURN NEW;
          END;
          $$;
DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_trigger
              WHERE tgname = 'rezku_employee_directory_sync'
                AND tgrelid = 'rezku_shifts'::regclass
                AND NOT tgisinternal
            ) THEN
              CREATE TRIGGER rezku_employee_directory_sync
              AFTER INSERT OR UPDATE OF employee_name, position, role_group
              ON rezku_shifts
              FOR EACH ROW
              EXECUTE FUNCTION corner_ops_sync_rezku_employee();
            END IF;
          EXCEPTION WHEN duplicate_object THEN NULL;
          END;
          $$;

-- src/lib/employment-forms.ts:ensureEmploymentFormsSchema
CREATE TABLE IF NOT EXISTS employment_form_profiles (
            business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
            profile JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE TABLE IF NOT EXISTS employment_forms (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_id UUID NOT NULL REFERENCES employees(id),
            employee_name TEXT NOT NULL,
            form_type TEXT NOT NULL CHECK (form_type IN ('W4', 'IT2104', 'I9', 'PAY_NOTICE', 'MEAL_POLICY')),
            title TEXT NOT NULL,
            template_version TEXT NOT NULL,
            source_url TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('Assigned', 'Employee Signed', 'Employer Review', 'Completed', 'Superseded')),
            effective_date DATE,
            encrypted_payload TEXT NOT NULL,
            assigned_by TEXT NOT NULL,
            assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            employee_signature_name TEXT NOT NULL DEFAULT '',
            employee_signed_at TIMESTAMPTZ,
            employer_signature_name TEXT NOT NULL DEFAULT '',
            employer_signed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS employment_forms_employee_idx ON employment_forms (employee_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS employment_forms_business_status_idx ON employment_forms (business, status, assigned_at DESC);
CREATE TABLE IF NOT EXISTS employment_form_events (
            id UUID PRIMARY KEY,
            form_id UUID NOT NULL REFERENCES employment_forms(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            actor TEXT NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS employment_form_events_form_idx ON employment_form_events (form_id, created_at);

-- src/lib/manual-time-entry.ts:ensureManualTimeAuditSchema
CREATE TABLE IF NOT EXISTS manual_time_entry_audit (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id UUID NOT NULL,
            employee_id UUID NOT NULL,
            employee_name TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'Manager Added',
            actor TEXT NOT NULL,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

-- src/lib/message-reads.ts:ensureMessageReadSchema
CREATE TABLE IF NOT EXISTS schedule_shifts (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
            position TEXT NOT NULL DEFAULT '',
            starts_at TIMESTAMPTZ NOT NULL,
            ends_at TIMESTAMPTZ NOT NULL,
            status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Open', 'Cancelled')),
            notes TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            published_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (ends_at > starts_at)
          );
CREATE INDEX IF NOT EXISTS schedule_shifts_business_start_idx ON schedule_shifts (business, starts_at, status);
CREATE INDEX IF NOT EXISTS schedule_shifts_employee_idx ON schedule_shifts (employee_id, starts_at);
ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS time_off_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS employee_availability (
            id UUID PRIMARY KEY,
            employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
            available BOOLEAN NOT NULL DEFAULT TRUE,
            available_from TEXT NOT NULL DEFAULT '',
            available_to TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (employee_id, weekday)
          );
CREATE TABLE IF NOT EXISTS time_off_requests (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            starts_on DATE NOT NULL,
            ends_on DATE NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
            manager_note TEXT NOT NULL DEFAULT '',
            reviewed_by TEXT NOT NULL DEFAULT '',
            reviewed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (ends_on >= starts_on)
          );
CREATE INDEX IF NOT EXISTS time_off_business_status_idx ON time_off_requests (business, status, starts_on);
CREATE TABLE IF NOT EXISTS shift_requests (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            request_type TEXT NOT NULL CHECK (request_type IN ('Claim', 'Offer', 'Swap')),
            shift_id UUID NOT NULL REFERENCES schedule_shifts(id) ON DELETE CASCADE,
            offered_shift_id UUID REFERENCES schedule_shifts(id) ON DELETE SET NULL,
            requester_employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            target_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
            employee_response TEXT NOT NULL DEFAULT 'Pending' CHECK (employee_response IN ('Pending', 'Accepted', 'Declined', 'Not Required')),
            status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
            note TEXT NOT NULL DEFAULT '',
            manager_note TEXT NOT NULL DEFAULT '',
            reviewed_by TEXT NOT NULL DEFAULT '',
            reviewed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS shift_requests_business_status_idx ON shift_requests (business, status, created_at DESC);
CREATE TABLE IF NOT EXISTS employee_messages (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            sender_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
            sender_name TEXT NOT NULL,
            recipient_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
            message_type TEXT NOT NULL DEFAULT 'Team' CHECK (message_type IN ('Team', 'Direct', 'Announcement')),
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS employee_messages_business_created_idx ON employee_messages (business, created_at DESC);
CREATE TABLE IF NOT EXISTS time_correction_requests (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            source_type TEXT NOT NULL CHECK (source_type IN ('Corner Ops', 'Rezku')),
            source_id UUID NOT NULL,
            original_clock_in TIMESTAMPTZ,
            original_clock_out TIMESTAMPTZ,
            requested_clock_in TIMESTAMPTZ,
            requested_clock_out TIMESTAMPTZ,
            original_reported_hours NUMERIC(10,4) NOT NULL DEFAULT 0,
            requested_reported_hours NUMERIC(10,4),
            reason TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
            manager_note TEXT NOT NULL DEFAULT '',
            reviewed_by TEXT NOT NULL DEFAULT '',
            reviewed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS correction_business_status_idx ON time_correction_requests (business, status, created_at DESC);
ALTER TABLE employee_messages ADD COLUMN IF NOT EXISTS conversation_key TEXT;
UPDATE employee_messages
          SET conversation_key = CASE
            WHEN message_type IN ('Team', 'Announcement') THEN 'team'
            WHEN sender_employee_id IS NULL AND recipient_employee_id IS NOT NULL
              THEN 'owner:' || recipient_employee_id::text
            WHEN sender_employee_id IS NOT NULL AND recipient_employee_id IS NOT NULL
              THEN 'direct:' || LEAST(sender_employee_id::text, recipient_employee_id::text)
                || ':' || GREATEST(sender_employee_id::text, recipient_employee_id::text)
            WHEN sender_employee_id IS NOT NULL THEN 'owner:' || sender_employee_id::text
            ELSE 'legacy:' || id::text
          END
          WHERE conversation_key IS NULL OR conversation_key = '';
ALTER TABLE employee_messages ALTER COLUMN conversation_key SET NOT NULL;
CREATE TABLE IF NOT EXISTS employee_message_recipients (
            message_id UUID NOT NULL REFERENCES employee_messages(id) ON DELETE CASCADE,
            employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (message_id, employee_id)
          );
INSERT INTO employee_message_recipients (message_id, employee_id)
          SELECT m.id, e.id
          FROM employee_messages m
          JOIN employees e ON e.business = m.business AND e.created_at <= m.created_at
          WHERE m.message_type IN ('Team', 'Announcement')
          ON CONFLICT (message_id, employee_id) DO NOTHING;
INSERT INTO employee_message_recipients (message_id, employee_id)
          SELECT m.id, participant.employee_id
          FROM employee_messages m
          CROSS JOIN LATERAL (VALUES (m.sender_employee_id), (m.recipient_employee_id)) AS participant(employee_id)
          WHERE participant.employee_id IS NOT NULL
            AND m.message_type NOT IN ('Team', 'Announcement')
          ON CONFLICT (message_id, employee_id) DO NOTHING;
ALTER TABLE employee_messages DROP CONSTRAINT IF EXISTS employee_messages_message_type_check;
ALTER TABLE employee_messages ADD CONSTRAINT employee_messages_message_type_check
          CHECK (message_type IN ('Team', 'Direct', 'Announcement', 'Conversation'));
UPDATE employee_messages SET message_type = 'Conversation'
          WHERE message_type IN ('Team', 'Announcement');
CREATE INDEX IF NOT EXISTS employee_messages_conversation_idx
          ON employee_messages (business, conversation_key, created_at, id)
          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS employee_message_recipients_employee_idx
          ON employee_message_recipients (employee_id, message_id);
CREATE TABLE IF NOT EXISTS employee_message_reactions (
            message_id UUID NOT NULL REFERENCES employee_messages(id) ON DELETE CASCADE,
            employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            reaction TEXT NOT NULL CHECK (reaction IN ('thumbs_up', 'thumbs_down', 'heart', 'laugh', 'eggplant_mouth')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (message_id, employee_id)
          );
CREATE INDEX IF NOT EXISTS employee_message_reactions_message_idx
          ON employee_message_reactions (message_id, reaction);
CREATE TABLE IF NOT EXISTS owner_message_reactions (
            message_id UUID NOT NULL REFERENCES employee_messages(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            reaction TEXT NOT NULL CHECK (reaction IN ('thumbs_up', 'thumbs_down', 'heart', 'laugh', 'eggplant_mouth')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (message_id, user_id)
          );
CREATE INDEX IF NOT EXISTS owner_message_reactions_message_idx
          ON owner_message_reactions (message_id, reaction);

-- src/lib/missed-clock-outs.ts:ensureMissedClockOutSchema
CREATE TABLE IF NOT EXISTS time_entry_adjustments (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        source_type TEXT NOT NULL CHECK (source_type IN ('Tiki', 'Rezku')),
        source_id UUID NOT NULL,
        before_state JSONB NOT NULL,
        after_state JSONB NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS time_entry_adjustments_source_idx ON time_entry_adjustments (source_type, source_id, created_at DESC);
CREATE TABLE IF NOT EXISTS tip_overrides (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        week_start DATE NOT NULL,
        source_transaction_id TEXT NOT NULL DEFAULT '',
        employee_name TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS tip_overrides_week_idx ON tip_overrides (business, week_start, created_at);
CREATE TABLE IF NOT EXISTS payroll_run_versions (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        week_start DATE NOT NULL,
        week_end TIMESTAMPTZ NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Locked')),
        payload JSONB NOT NULL,
        generated_by TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_by TEXT,
        locked_at TIMESTAMPTZ,
        reopened_from_id UUID REFERENCES payroll_run_versions(id),
        UNIQUE (business, week_start, version)
      );
CREATE INDEX IF NOT EXISTS payroll_run_versions_week_idx ON payroll_run_versions (business, week_start DESC, version DESC);
CREATE TABLE IF NOT EXISTS payroll_audit_events (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
        event_type TEXT NOT NULL,
        reference_id TEXT NOT NULL DEFAULT '',
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        actor TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS payroll_audit_events_business_idx ON payroll_audit_events (business, created_at DESC);
CREATE TABLE IF NOT EXISTS missed_clock_out_cases (
            id UUID PRIMARY KEY,
            time_entry_id UUID NOT NULL UNIQUE REFERENCES time_entries(id) ON DELETE CASCADE,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_id UUID NOT NULL,
            employee_name TEXT NOT NULL,
            position TEXT NOT NULL DEFAULT '',
            clock_in TIMESTAMPTZ NOT NULL,
            business_date DATE NOT NULL,
            close_basis TEXT NOT NULL CHECK (close_basis IN ('business_close', 'scheduled_end', 'max_shift')),
            close_at TIMESTAMPTZ NOT NULL,
            shift_id UUID,
            scheduled_end TIMESTAMPTZ,
            status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Submitted', 'Resolved')),
            employee_left_at TIMESTAMPTZ,
            employee_note TEXT NOT NULL DEFAULT '',
            employee_submitted_at TIMESTAMPTZ,
            sms_status TEXT NOT NULL DEFAULT '',
            sms_detail TEXT NOT NULL DEFAULT '',
            sms_sent_at TIMESTAMPTZ,
            owner_notified_at TIMESTAMPTZ,
            owner_notify_error TEXT NOT NULL DEFAULT '',
            resolution TEXT NOT NULL DEFAULT '' CHECK (resolution IN ('', 'scheduled_end', 'employee_time', 'custom', 'closed_elsewhere')),
            resolved_clock_out TIMESTAMPTZ,
            resolved_by TEXT NOT NULL DEFAULT '',
            resolved_at TIMESTAMPTZ,
            detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
ALTER TABLE missed_clock_out_cases ALTER COLUMN time_entry_id DROP NOT NULL;
ALTER TABLE missed_clock_out_cases ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS rezku_shift_id UUID UNIQUE REFERENCES rezku_shifts(id) ON DELETE CASCADE;
ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'open_punch';
ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS punch_clock_out TIMESTAMPTZ;
ALTER TABLE missed_clock_out_cases ADD COLUMN IF NOT EXISTS auto_close_basis TEXT;
ALTER TABLE missed_clock_out_cases DROP CONSTRAINT IF EXISTS missed_clock_out_cases_status_check;
ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_status_check CHECK (status IN ('Open', 'AutoClosed', 'Submitted', 'Resolved'));
ALTER TABLE missed_clock_out_cases DROP CONSTRAINT IF EXISTS missed_clock_out_cases_resolution_check;
ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_resolution_check
            CHECK (resolution IN ('', 'scheduled_end', 'employee_time', 'custom', 'closed_elsewhere', 'kept', 'confirmed'));
ALTER TABLE missed_clock_out_cases DROP CONSTRAINT IF EXISTS missed_clock_out_cases_close_basis_check;
ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_close_basis_check
            CHECK (close_basis IN ('business_close', 'scheduled_end', 'max_shift', 'none'));
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('missed_clock_out_cases') AND conname = 'missed_clock_out_cases_kind_check') THEN
    ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_kind_check
            CHECK (kind IN ('open_punch', 'auto_closed', 'late_clock_out', 'unscheduled'));
  END IF;
END $mig$;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('missed_clock_out_cases') AND conname = 'missed_clock_out_cases_source_check') THEN
    ALTER TABLE missed_clock_out_cases ADD CONSTRAINT missed_clock_out_cases_source_check
            CHECK ((time_entry_id IS NOT NULL) <> (rezku_shift_id IS NOT NULL));
  END IF;
END $mig$;
CREATE INDEX IF NOT EXISTS missed_clock_out_cases_business_idx ON missed_clock_out_cases (business, status, clock_in DESC);
CREATE INDEX IF NOT EXISTS missed_clock_out_cases_employee_idx ON missed_clock_out_cases (employee_id, clock_in DESC);

-- src/lib/mx-merchant.ts:ensureMxPaymentSchema
CREATE TABLE IF NOT EXISTS ordering_mx_checkout_sessions(id UUID PRIMARY KEY,business TEXT NOT NULL,order_id UUID NOT NULL REFERENCES ordering_orders(id),check_id UUID,amount_cents INTEGER NOT NULL,replay_id BIGINT NOT NULL UNIQUE,client_mutation_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'initialized',provider_transaction_reference TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS ordering_mx_checkout_order_idx ON ordering_mx_checkout_sessions(order_id,created_at DESC);

-- src/lib/mx-refunds.ts:ensureSchema
CREATE TABLE IF NOT EXISTS ordering_mx_reversal_attempts(
        id UUID PRIMARY KEY,
        business TEXT NOT NULL,
        order_id UUID NOT NULL,
        source_transaction_id UUID NOT NULL,
        source_reference TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        full_reversal BOOLEAN NOT NULL,
        replay_id BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','failed','applied')),
        kind TEXT NOT NULL DEFAULT '',
        mx_reference TEXT NOT NULL DEFAULT '',
        mx_response JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS ordering_mx_reversal_source_idx ON ordering_mx_reversal_attempts(source_transaction_id, status);

-- src/lib/mx-terminal-payments.ts:ensureSchema
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'keyed';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS station_key TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS terminal_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS terminal_payment_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS status_message TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS auth_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS payment_token TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS auth_code TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS tip_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS completion_replay_id BIGINT;
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS completion_started_at TIMESTAMPTZ;
ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS capture_base_cents INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_mx_terminal_one_active_idx ON ordering_mx_checkout_sessions(terminal_id) WHERE channel='terminal' AND status IN ('sending','sent');

-- src/lib/ordering-ai-schema.ts:ensureOrderingAiSchema
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS fulfillment_question_state TEXT NOT NULL DEFAULT 'not_asked';
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_call_sessions') AND c.conname = 'ordering_call_sessions_fulfillment_question_state_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:813ea35151f7a26284c190d169f90ac3'
  ) THEN
    ALTER TABLE ordering_call_sessions DROP CONSTRAINT IF EXISTS ordering_call_sessions_fulfillment_question_state_check;
    ALTER TABLE ordering_call_sessions ADD CONSTRAINT ordering_call_sessions_fulfillment_question_state_check CHECK (fulfillment_question_state IN ('not_asked', 'asked_unanswered', 'deferred_while_ordering', 'resolved')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_call_sessions_fulfillment_question_state_check ON ordering_call_sessions IS 'corner-ops:813ea35151f7a26284c190d169f90ac3';
    BEGIN
      ALTER TABLE ordering_call_sessions VALIDATE CONSTRAINT ordering_call_sessions_fulfillment_question_state_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_call_sessions_fulfillment_question_state_check', 'ordering_call_sessions';
    END;
  END IF;
END $mig$;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS deferred_required_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS pending_item JSONB;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS last_customer_turn_at TIMESTAMPTZ;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS last_ai_turn_at TIMESTAMPTZ;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS last_natural_break_at TIMESTAMPTZ;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS called_did TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS line_label TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS claimed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS selected_model TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS selected_provider TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS bridge_action TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS operating_mode TEXT NOT NULL DEFAULT 'shadow';
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_call_sessions') AND c.conname = 'ordering_call_sessions_operating_mode_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:e6d65f6170fd75ee507e4bf4488b0975'
  ) THEN
    ALTER TABLE ordering_call_sessions DROP CONSTRAINT IF EXISTS ordering_call_sessions_operating_mode_check;
    ALTER TABLE ordering_call_sessions ADD CONSTRAINT ordering_call_sessions_operating_mode_check CHECK(operating_mode IN ('shadow','assisted','autonomous')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_call_sessions_operating_mode_check ON ordering_call_sessions IS 'corner-ops:e6d65f6170fd75ee507e4bf4488b0975';
    BEGIN
      ALTER TABLE ordering_call_sessions VALIDATE CONSTRAINT ordering_call_sessions_operating_mode_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_call_sessions_operating_mode_check', 'ordering_call_sessions';
    END;
  END IF;
END $mig$;
CREATE INDEX IF NOT EXISTS ordering_call_sessions_fulfillment_state_idx ON ordering_call_sessions (business, fulfillment_question_state, updated_at DESC);
CREATE TABLE IF NOT EXISTS ordering_ai_tool_events (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            request_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL DEFAULT '',
            tool_name TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            order_id UUID REFERENCES ordering_orders(id),
            customer_id UUID REFERENCES ordering_customers(id),
            outcome TEXT NOT NULL CHECK (outcome IN ('success', 'blocked', 'error')),
            error_code TEXT NOT NULL DEFAULT '',
            input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
            model TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE UNIQUE INDEX IF NOT EXISTS ordering_ai_tool_events_request_idx ON ordering_ai_tool_events (business, request_id);
CREATE INDEX IF NOT EXISTS ordering_ai_tool_events_order_idx ON ordering_ai_tool_events (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_ai_tool_events_conversation_idx ON ordering_ai_tool_events (business, conversation_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ordering_ai_call_events (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            call_id TEXT NOT NULL,
            event_key TEXT NOT NULL,
            event_type TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'system',
            label TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            duration_ms INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, event_key)
          );
CREATE INDEX IF NOT EXISTS ordering_ai_call_events_call_idx ON ordering_ai_call_events (business, call_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ordering_ai_phone_settings (
            business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli','Tiki')),
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','assisted','autonomous')),
            model TEXT NOT NULL DEFAULT 'gpt-realtime-1.5',
            max_response_words INTEGER NOT NULL DEFAULT 10 CHECK (max_response_words BETWEEN 2 AND 30),
            max_upsells INTEGER NOT NULL DEFAULT 2 CHECK (max_upsells BETWEEN 0 AND 3),
            vad_eagerness TEXT NOT NULL DEFAULT 'high' CHECK (vad_eagerness IN ('low','medium','high')),
            recording_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            transcript_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (transcript_retention_days BETWEEN 1 AND 365),
            updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
ALTER TABLE ordering_ai_phone_settings ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openai';
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_ai_phone_settings') AND c.conname = 'ordering_ai_phone_settings_provider_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:37c886d05f9fa1e913db6fafa8b241b8'
  ) THEN
    ALTER TABLE ordering_ai_phone_settings DROP CONSTRAINT IF EXISTS ordering_ai_phone_settings_provider_check;
    ALTER TABLE ordering_ai_phone_settings ADD CONSTRAINT ordering_ai_phone_settings_provider_check CHECK(provider IN ('openai','gemini')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_ai_phone_settings_provider_check ON ordering_ai_phone_settings IS 'corner-ops:37c886d05f9fa1e913db6fafa8b241b8';
    BEGIN
      ALTER TABLE ordering_ai_phone_settings VALIDATE CONSTRAINT ordering_ai_phone_settings_provider_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_ai_phone_settings_provider_check', 'ordering_ai_phone_settings';
    END;
  END IF;
END $mig$;
ALTER TABLE ordering_ai_phone_settings ADD COLUMN IF NOT EXISTS openai_model TEXT NOT NULL DEFAULT 'gpt-realtime-1.5';
ALTER TABLE ordering_ai_phone_settings ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-flash-live-preview';
CREATE TABLE IF NOT EXISTS ordering_call_transcript_segments (
            id UUID PRIMARY KEY, business TEXT NOT NULL, call_id TEXT NOT NULL, event_key TEXT NOT NULL,
            speaker TEXT NOT NULL CHECK (speaker IN ('customer','assistant','system')),
            transcript TEXT NOT NULL, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confidence NUMERIC(6,5), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE(business,event_key)
          );
CREATE INDEX IF NOT EXISTS ordering_call_transcript_call_idx ON ordering_call_transcript_segments(business,call_id,completed_at);
CREATE TABLE IF NOT EXISTS ordering_ai_latency_samples (
            id UUID PRIMARY KEY, business TEXT NOT NULL, call_id TEXT NOT NULL, turn_id TEXT NOT NULL DEFAULT '',
            metric TEXT NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms>=0), model TEXT NOT NULL DEFAULT '',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS ordering_ai_latency_call_idx ON ordering_ai_latency_samples(business,call_id,created_at);
CREATE TABLE IF NOT EXISTS ordering_ai_upsell_events (
            id UUID PRIMARY KEY,business TEXT NOT NULL,call_id TEXT NOT NULL,order_id UUID REFERENCES ordering_orders(id),
            rule_id UUID REFERENCES ordering_upsell_rules(id),offered_item_id UUID REFERENCES ordering_menu_items(id),
            outcome TEXT NOT NULL CHECK(outcome IN ('offered','accepted','declined','skipped')),
            revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK(revenue_cents>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS ordering_ai_upsell_call_idx ON ordering_ai_upsell_events(business,call_id,created_at);
CREATE TABLE IF NOT EXISTS ordering_call_reviews (
            id UUID PRIMARY KEY,business TEXT NOT NULL,call_id TEXT NOT NULL,order_id UUID REFERENCES ordering_orders(id),
            rating TEXT NOT NULL CHECK(rating IN ('good','needs_review','ai_error','customer_error','menu_rule_problem','employee_follow_up')),
            notes TEXT NOT NULL DEFAULT '',expected_order JSONB NOT NULL DEFAULT '{}'::jsonb,ai_order JSONB NOT NULL DEFAULT '{}'::jsonb,
            differences JSONB NOT NULL DEFAULT '[]'::jsonb,reviewed_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(business,call_id)
          );
CREATE TABLE IF NOT EXISTS ordering_ai_regression_cases (
            id UUID PRIMARY KEY,business TEXT NOT NULL,case_key TEXT NOT NULL,case_type TEXT NOT NULL CHECK(case_type IN('order_resolution','speech_completion')),
            source TEXT NOT NULL,call_id TEXT NOT NULL DEFAULT '',input JSONB NOT NULL DEFAULT '{}'::jsonb,expected JSONB NOT NULL DEFAULT '{}'::jsonb,
            active BOOLEAN NOT NULL DEFAULT TRUE,first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(business,case_key)
          );
CREATE INDEX IF NOT EXISTS ordering_ai_regression_active_idx ON ordering_ai_regression_cases(business,active,case_type);

-- src/lib/ordering-auto-print.ts:ensureSchema
CREATE TABLE IF NOT EXISTS ordering_external_print_settings (business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli','Tiki')), auto_print_enabled BOOLEAN NOT NULL DEFAULT FALSE, updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- src/lib/ordering-barcode-schema.ts:ensureOrderingBarcodeSchema
CREATE TABLE IF NOT EXISTS ordering_barcode_mappings (
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        barcode TEXT NOT NULL,
        barcode_format TEXT NOT NULL CHECK (barcode_format IN ('upc_a','ean_8','ean_13','gtin_14','code_128_text')),
        item_id UUID NOT NULL REFERENCES ordering_menu_items(id),
        variant_id UUID REFERENCES ordering_menu_item_variants(id),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL
      );
CREATE UNIQUE INDEX IF NOT EXISTS ordering_barcode_one_active_idx ON ordering_barcode_mappings (business, barcode) WHERE active=TRUE;
CREATE INDEX IF NOT EXISTS ordering_barcode_target_idx ON ordering_barcode_mappings (business,item_id,variant_id,active);
CREATE TABLE IF NOT EXISTS ordering_barcode_audit (
        id UUID PRIMARY KEY,
        mapping_id UUID NOT NULL REFERENCES ordering_barcode_mappings(id),
        business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        action TEXT NOT NULL CHECK (action IN ('created','updated','activated','deactivated')),
        barcode TEXT NOT NULL,
        before_state JSONB,
        after_state JSONB,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS ordering_barcode_audit_mapping_idx ON ordering_barcode_audit(mapping_id,created_at DESC);

-- src/lib/ordering-delivery-schema.ts:ensureOrderingDeliverySchema
CREATE TABLE IF NOT EXISTS ordering_business_tax_settings (
            business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
            prices_include_tax BOOLEAN NOT NULL DEFAULT TRUE,
            tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
            tax_rate_configured BOOLEAN NOT NULL DEFAULT FALSE,
            delivery_fee_taxable BOOLEAN NOT NULL DEFAULT TRUE,
            minimum_adjustment_taxable BOOLEAN NOT NULL DEFAULT TRUE,
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE TABLE IF NOT EXISTS ordering_delivery_policies (
            business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            minimum_order_cents INTEGER NOT NULL DEFAULT 0 CHECK (minimum_order_cents >= 0),
            minimum_basis TEXT NOT NULL DEFAULT 'merchandise_after_discounts',
            offer_upsell_before_shortfall_fee BOOLEAN NOT NULL DEFAULT TRUE,
            allow_shortfall_fee BOOLEAN NOT NULL DEFAULT TRUE,
            shortfall_fee_label TEXT NOT NULL DEFAULT 'Round up to delivery minimum',
            allow_manager_bypass BOOLEAN NOT NULL DEFAULT TRUE,
            notify_management_on_bypass BOOLEAN NOT NULL DEFAULT TRUE,
            max_distance_miles NUMERIC(6,2),
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (max_distance_miles IS NULL OR max_distance_miles > 0)
          );
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_delivery_policies') AND c.conname = 'ordering_delivery_policies_minimum_basis_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:b0ea7a5957665b37438f2261d5f85279'
  ) THEN
    ALTER TABLE ordering_delivery_policies DROP CONSTRAINT IF EXISTS ordering_delivery_policies_minimum_basis_check;
    ALTER TABLE ordering_delivery_policies ADD CONSTRAINT ordering_delivery_policies_minimum_basis_check CHECK (minimum_basis IN ('merchandise_after_discounts', 'order_total_including_delivery_fee')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_delivery_policies_minimum_basis_check ON ordering_delivery_policies IS 'corner-ops:b0ea7a5957665b37438f2261d5f85279';
    BEGIN
      ALTER TABLE ordering_delivery_policies VALIDATE CONSTRAINT ordering_delivery_policies_minimum_basis_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_delivery_policies_minimum_basis_check', 'ordering_delivery_policies';
    END;
  END IF;
END $mig$;
ALTER TABLE ordering_delivery_policies ALTER COLUMN minimum_basis SET DEFAULT 'merchandise_after_discounts';
CREATE TABLE IF NOT EXISTS ordering_delivery_fee_bands (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            min_miles NUMERIC(6,2) NOT NULL CHECK (min_miles >= 0),
            max_miles NUMERIC(6,2) NOT NULL CHECK (max_miles > 0),
            fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_by TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (max_miles > min_miles),
            UNIQUE (business, min_miles, max_miles)
          );
CREATE INDEX IF NOT EXISTS ordering_delivery_fee_bands_lookup_idx ON ordering_delivery_fee_bands (business, active, sort_order, max_miles);
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS delivery_distance_miles NUMERIC(6,2);
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS delivery_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS minimum_order_cents_snapshot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS minimum_order_adjustment_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS tax_rate_bps_snapshot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS prices_include_tax_snapshot BOOLEAN NOT NULL DEFAULT TRUE;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_orders') AND c.conname = 'ordering_orders_delivery_distance_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:7a124b06d5151b35e6d1c3ea6516bf8d'
  ) THEN
    ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_delivery_distance_check;
    ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_delivery_distance_check CHECK (delivery_distance_miles IS NULL OR delivery_distance_miles >= 0) NOT VALID;
    COMMENT ON CONSTRAINT ordering_orders_delivery_distance_check ON ordering_orders IS 'corner-ops:7a124b06d5151b35e6d1c3ea6516bf8d';
    BEGIN
      ALTER TABLE ordering_orders VALIDATE CONSTRAINT ordering_orders_delivery_distance_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_orders_delivery_distance_check', 'ordering_orders';
    END;
  END IF;
END $mig$;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_orders') AND c.conname = 'ordering_orders_delivery_fee_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:46f17bf17e04cf9fca52ddd311cd1bb5'
  ) THEN
    ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_delivery_fee_check;
    ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_delivery_fee_check CHECK ( delivery_fee_cents >= 0 AND minimum_order_cents_snapshot >= 0 AND minimum_order_adjustment_cents >= 0 AND tax_rate_bps_snapshot >= 0 ) NOT VALID;
    COMMENT ON CONSTRAINT ordering_orders_delivery_fee_check ON ordering_orders IS 'corner-ops:46f17bf17e04cf9fca52ddd311cd1bb5';
    BEGIN
      ALTER TABLE ordering_orders VALIDATE CONSTRAINT ordering_orders_delivery_fee_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_orders_delivery_fee_check', 'ordering_orders';
    END;
  END IF;
END $mig$;
CREATE TABLE IF NOT EXISTS ordering_delivery_minimum_exceptions (
            id UUID PRIMARY KEY,
            order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            resolution_type TEXT NOT NULL CHECK (resolution_type IN ('shortfall_fee', 'bypass')),
            minimum_order_cents INTEGER NOT NULL CHECK (minimum_order_cents >= 0),
            merchandise_subtotal_cents INTEGER NOT NULL CHECK (merchandise_subtotal_cents >= 0),
            shortfall_cents INTEGER NOT NULL CHECK (shortfall_cents >= 0),
            adjustment_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (adjustment_fee_cents >= 0),
            upsell_offered BOOLEAN NOT NULL DEFAULT FALSE,
            customer_declined_upsell BOOLEAN NOT NULL DEFAULT FALSE,
            actor_type TEXT NOT NULL CHECK (actor_type IN ('ai', 'employee', 'web', 'system')),
            actor_id TEXT NOT NULL DEFAULT '',
            approved_by TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (
              (resolution_type = 'shortfall_fee' AND adjustment_fee_cents = shortfall_cents)
              OR (resolution_type = 'bypass' AND adjustment_fee_cents = 0)
            )
          );
CREATE INDEX IF NOT EXISTS ordering_delivery_minimum_exceptions_order_idx ON ordering_delivery_minimum_exceptions (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ordering_delivery_minimum_exceptions_business_idx ON ordering_delivery_minimum_exceptions (business, created_at DESC);
CREATE TABLE IF NOT EXISTS ordering_management_alerts (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            order_id UUID REFERENCES ordering_orders(id) ON DELETE CASCADE,
            alert_type TEXT NOT NULL CHECK (alert_type IN ('delivery_minimum_bypass')),
            severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            acknowledged_by TEXT NOT NULL DEFAULT '',
            acknowledged_at TIMESTAMPTZ,
            resolved_at TIMESTAMPTZ,
            details JSONB NOT NULL DEFAULT '{}'::jsonb
          );
CREATE INDEX IF NOT EXISTS ordering_management_alerts_open_idx ON ordering_management_alerts (business, status, created_at DESC);

-- src/lib/ordering-driver-delivery.ts:ensureDriverDeliverySchema
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS business TEXT;
ALTER TABLE ordering_delivery_assignments ALTER COLUMN driver_employee_id DROP NOT NULL;
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ;
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMPTZ;
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS status_note TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE ordering_delivery_assignments d SET business=o.business FROM ordering_orders o WHERE o.id=d.order_id AND d.business IS NULL;
UPDATE ordering_delivery_assignments SET status=CASE status WHEN 'assigned' THEN 'ASSIGNED' WHEN 'out_for_delivery' THEN 'EN_ROUTE' WHEN 'delivered' THEN 'DELIVERED' WHEN 'failed' THEN 'DELIVERY_FAILED' WHEN 'returned' THEN 'RETURNED' WHEN 'cancelled' THEN 'CANCELLED' ELSE status END;
ALTER TABLE ordering_delivery_assignments DROP CONSTRAINT IF EXISTS ordering_delivery_assignments_status_check;
ALTER TABLE ordering_delivery_assignments ADD CONSTRAINT ordering_delivery_assignments_status_check CHECK(status IN ('ASSIGNED','READY_FOR_DRIVER','PICKED_UP','EN_ROUTE','ARRIVED','DELIVERED','NO_CONTACT','DELIVERY_FAILED','RETURNED','CANCELLED'));
CREATE INDEX IF NOT EXISTS ordering_delivery_assignments_driver_idx ON ordering_delivery_assignments(driver_employee_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS ordering_delivery_audit(
      id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
      order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE, employee_id UUID REFERENCES employees(id),
      device_session_id UUID, action TEXT NOT NULL, previous_status TEXT, new_status TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ordering_delivery_tracking_sessions(
      id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
      driver_id UUID NOT NULL REFERENCES employees(id), device_session_id UUID, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stopped_at TIMESTAMPTZ, stop_reason TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS ordering_delivery_tracking_active_idx ON ordering_delivery_tracking_sessions(delivery_id) WHERE stopped_at IS NULL;
CREATE TABLE IF NOT EXISTS ordering_delivery_locations(
      id UUID PRIMARY KEY, tracking_session_id UUID NOT NULL REFERENCES ordering_delivery_tracking_sessions(id) ON DELETE CASCADE,
      delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE, driver_id UUID NOT NULL REFERENCES employees(id),
      device_session_id UUID, client_event_id TEXT NOT NULL, captured_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      latitude NUMERIC(10,7) NOT NULL, longitude NUMERIC(10,7) NOT NULL, accuracy_meters NUMERIC(9,2), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE(driver_id,client_event_id));
CREATE TABLE IF NOT EXISTS ordering_delivery_proofs(
      id UUID PRIMARY KEY, order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
      delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE, employee_id UUID NOT NULL REFERENCES employees(id),
      storage_reference TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
      latitude NUMERIC(10,7), longitude NUMERIC(10,7), accuracy_meters NUMERIC(9,2), proof_type TEXT NOT NULL,
      employee_note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ordering_delivery_tracking_tokens(
      id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
      order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, token_value TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE ordering_delivery_tracking_tokens ADD COLUMN IF NOT EXISTS token_value TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS ordering_delivery_customer_notifications(
      id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
      order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE, tracking_token_id UUID REFERENCES ordering_delivery_tracking_tokens(id),
      channel TEXT NOT NULL, destination TEXT NOT NULL, classification TEXT NOT NULL DEFAULT 'transactional', payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, failure TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS ordering_driver_dispatch_settings(business TEXT PRIMARY KEY CHECK(business IN('Corner Deli','Tiki')),show_live_driver BOOLEAN NOT NULL DEFAULT FALSE,call_link_template TEXT NOT NULL DEFAULT '',updated_by UUID REFERENCES employees(id),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE ordering_driver_dispatch_settings ADD COLUMN IF NOT EXISTS auto_assign_solo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ordering_driver_dispatch_settings ADD COLUMN IF NOT EXISTS anyone_can_deliver BOOLEAN NOT NULL DEFAULT TRUE;

-- src/lib/ordering-employee-meals.ts:ensureEmployeeMealSchema
CREATE TABLE IF NOT EXISTS ordering_business_ordering_settings (
            business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
            timezone TEXT NOT NULL DEFAULT 'America/New_York',
            after_hours_ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            allow_future_orders_when_closed BOOLEAN NOT NULL DEFAULT TRUE,
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE TABLE IF NOT EXISTS ordering_business_hours (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
            opens_at TIME NOT NULL,
            closes_at TIME NOT NULL,
            accepts_orders BOOLEAN NOT NULL DEFAULT TRUE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_by TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (closes_at <> opens_at)
          );
CREATE INDEX IF NOT EXISTS ordering_business_hours_lookup_idx ON ordering_business_hours (business, weekday, active, sort_order);
CREATE TABLE IF NOT EXISTS ordering_business_hour_exceptions (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            business_date DATE NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('closed', 'custom_hours')),
            opens_at TIME,
            closes_at TIME,
            note TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (
              (status = 'closed' AND opens_at IS NULL AND closes_at IS NULL)
              OR (status = 'custom_hours' AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at <> closes_at)
            ),
            UNIQUE (business, business_date)
          );
CREATE TABLE IF NOT EXISTS ordering_operating_windows (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            service_type TEXT NOT NULL DEFAULT 'all' CHECK (service_type IN ('all', 'pickup', 'delivery', 'dine_in', 'online', 'phone')),
            weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
            opens_at TIME NOT NULL,
            closes_at TIME NOT NULL,
            ordering_opens_at TIME,
            ordering_cutoff_at TIME,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_by TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (closes_at <> opens_at),
            CHECK ((ordering_opens_at IS NULL) = (ordering_cutoff_at IS NULL)),
            CHECK (ordering_opens_at IS NULL OR ordering_opens_at <> ordering_cutoff_at)
          );
CREATE INDEX IF NOT EXISTS ordering_operating_windows_lookup_idx ON ordering_operating_windows (business, service_type, weekday, active, sort_order);
CREATE TABLE IF NOT EXISTS ordering_special_hours (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            business_date DATE NOT NULL,
            service_type TEXT NOT NULL DEFAULT 'all' CHECK (service_type IN ('all', 'pickup', 'delivery', 'dine_in', 'online', 'phone')),
            status TEXT NOT NULL CHECK (status IN ('closed', 'custom_hours')),
            opens_at TIME,
            closes_at TIME,
            ordering_opens_at TIME,
            ordering_cutoff_at TIME,
            label TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (
              (status = 'closed' AND opens_at IS NULL AND closes_at IS NULL)
              OR (status = 'custom_hours' AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at <> closes_at)
            ),
            CHECK ((ordering_opens_at IS NULL) = (ordering_cutoff_at IS NULL)),
            UNIQUE (business, business_date, service_type)
          );
CREATE TABLE IF NOT EXISTS ordering_emergency_closures (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            service_type TEXT NOT NULL DEFAULT 'all' CHECK (service_type IN ('all', 'pickup', 'delivery', 'dine_in', 'online', 'phone')),
            starts_at TIMESTAMPTZ NOT NULL,
            ends_at TIMESTAMPTZ,
            reason TEXT NOT NULL,
            internal_note TEXT NOT NULL DEFAULT '',
            customer_message TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reopened_by TEXT,
            reopened_at TIMESTAMPTZ,
            CHECK (ends_at IS NULL OR ends_at > starts_at)
          );
CREATE INDEX IF NOT EXISTS ordering_emergency_closures_lookup_idx ON ordering_emergency_closures (business, service_type, starts_at DESC) WHERE reopened_at IS NULL;
CREATE TABLE IF NOT EXISTS ordering_operations_audit (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            actor_id TEXT NOT NULL,
            actor_role TEXT NOT NULL,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE TABLE IF NOT EXISTS ordering_menu_availability_rules (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            target_type TEXT NOT NULL CHECK (target_type IN ('item', 'variant', 'modifier_option')),
            target_id UUID NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            days_of_week SMALLINT[] NOT NULL DEFAULT '{}',
            starts_at TIME,
            ends_at TIME,
            valid_from DATE,
            valid_through DATE,
            updated_by TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK ((starts_at IS NULL) = (ends_at IS NULL)),
            CHECK (starts_at IS NULL OR starts_at <> ends_at),
            CHECK (valid_through IS NULL OR valid_from IS NULL OR valid_through >= valid_from),
            UNIQUE (business, target_type, target_id)
          );
CREATE INDEX IF NOT EXISTS ordering_menu_availability_lookup_idx ON ordering_menu_availability_rules (business, target_type, target_id) WHERE enabled=TRUE;
CREATE TABLE IF NOT EXISTS ordering_fulfillment_timing_settings (
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            service_type TEXT NOT NULL CHECK (service_type IN ('pickup', 'delivery', 'no_contact_delivery', 'dine_in', 'curbside', 'bar')),
            allow_asap BOOLEAN NOT NULL DEFAULT TRUE,
            allow_future BOOLEAN NOT NULL DEFAULT TRUE,
            normal_min_minutes INTEGER NOT NULL DEFAULT 30 CHECK (normal_min_minutes >= 0),
            normal_max_minutes INTEGER NOT NULL DEFAULT 30 CHECK (normal_max_minutes >= normal_min_minutes),
            busy_min_minutes INTEGER NOT NULL DEFAULT 60 CHECK (busy_min_minutes >= 0),
            busy_max_minutes INTEGER NOT NULL DEFAULT 60 CHECK (busy_max_minutes >= busy_min_minutes),
            busy_window_minutes INTEGER NOT NULL DEFAULT 15 CHECK (busy_window_minutes > 0),
            busy_order_threshold INTEGER CHECK (busy_order_threshold IS NULL OR busy_order_threshold >= 0),
            max_future_days INTEGER NOT NULL DEFAULT 30 CHECK (max_future_days >= 0),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (business, service_type)
          );
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS timing_mode TEXT NOT NULL DEFAULT 'asap';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS quoted_lead_min_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS quoted_lead_max_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS timing_message_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS kitchen_timing_label_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS kitchen_release_at TIMESTAMPTZ;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS operational_follow_up_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS affected_by_closure_id UUID;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_orders') AND c.conname = 'ordering_orders_timing_mode_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:12d5028a1cf4b9343b44c8ee12363ae4'
  ) THEN
    ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_timing_mode_check;
    ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_timing_mode_check CHECK (timing_mode IN ('asap', 'future')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_orders_timing_mode_check ON ordering_orders IS 'corner-ops:12d5028a1cf4b9343b44c8ee12363ae4';
    BEGIN
      ALTER TABLE ordering_orders VALIDATE CONSTRAINT ordering_orders_timing_mode_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_orders_timing_mode_check', 'ordering_orders';
    END;
  END IF;
END $mig$;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_orders') AND c.conname = 'ordering_orders_quoted_lead_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:5e42e7a702aaa20b610d4d1ce79cc28a'
  ) THEN
    ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_quoted_lead_check;
    ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_quoted_lead_check CHECK ( quoted_lead_min_minutes >= 0 AND quoted_lead_max_minutes >= quoted_lead_min_minutes ) NOT VALID;
    COMMENT ON CONSTRAINT ordering_orders_quoted_lead_check ON ordering_orders IS 'corner-ops:5e42e7a702aaa20b610d4d1ce79cc28a';
    BEGIN
      ALTER TABLE ordering_orders VALIDATE CONSTRAINT ordering_orders_quoted_lead_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_orders_quoted_lead_check', 'ordering_orders';
    END;
  END IF;
END $mig$;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS store_was_open BOOLEAN;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS next_open_at TIMESTAMPTZ;
ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS after_hours_order_offered BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS ordering_employee_meals(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),employee_id UUID NOT NULL REFERENCES employees(id),employee_name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS ordering_employee_meals_employee_idx ON ordering_employee_meals(employee_id,created_at DESC);
CREATE TABLE IF NOT EXISTS ordering_employee_meal_lines(id UUID PRIMARY KEY,meal_id UUID NOT NULL REFERENCES ordering_employee_meals(id) ON DELETE CASCADE,menu_item_id UUID NOT NULL REFERENCES ordering_menu_items(id),item_name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- src/lib/ordering-gift-card-schema.ts:ensureOrderingGiftCardSchema
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS card_number_hash TEXT;
UPDATE ordering_gift_cards SET card_number_hash=token_hash WHERE card_number_hash IS NULL;
ALTER TABLE ordering_gift_cards ALTER COLUMN card_number_hash SET NOT NULL;
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS masked_number TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS pin_verifier TEXT;
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS current_balance_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS deactivation_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS replaced_by_card_id UUID REFERENCES ordering_gift_cards(id);
ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS source_reference TEXT;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('ordering_gift_cards') AND conname = 'ordering_gift_cards_balance_nonnegative') THEN
    ALTER TABLE ordering_gift_cards ADD CONSTRAINT ordering_gift_cards_balance_nonnegative CHECK (current_balance_cents >= 0) NOT VALID;
  END IF;
END $mig$;
ALTER TABLE ordering_gift_cards VALIDATE CONSTRAINT ordering_gift_cards_balance_nonnegative;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_cards_number_hash_idx ON ordering_gift_cards(business,card_number_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_cards_source_idx ON ordering_gift_cards(business,source_reference) WHERE source_reference IS NOT NULL;
ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS business TEXT;
UPDATE ordering_gift_card_ledger ledger SET business=card.business FROM ordering_gift_cards card WHERE ledger.gift_card_id=card.id AND ledger.business IS NULL;
ALTER TABLE ordering_gift_card_ledger ALTER COLUMN business SET NOT NULL;
ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS balance_after_cents INTEGER;
ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS operation_key TEXT;
ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS related_entry_id UUID REFERENCES ordering_gift_card_ledger(id);
ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS approved_by TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_gift_card_ledger') AND c.conname = 'ordering_gift_card_ledger_entry_type_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:81f948d72c60b15ac31502ca9aef7b51'
  ) THEN
    ALTER TABLE ordering_gift_card_ledger DROP CONSTRAINT IF EXISTS ordering_gift_card_ledger_entry_type_check;
    ALTER TABLE ordering_gift_card_ledger ADD CONSTRAINT ordering_gift_card_ledger_entry_type_check CHECK(entry_type IN ('initial_load','issue','redeem','reload','refund','manager_adjustment','adjustment','expire','reversal','replacement_transfer_in','replacement_transfer_out','import_opening_balance')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_gift_card_ledger_entry_type_check ON ordering_gift_card_ledger IS 'corner-ops:81f948d72c60b15ac31502ca9aef7b51';
    BEGIN
      ALTER TABLE ordering_gift_card_ledger VALIDATE CONSTRAINT ordering_gift_card_ledger_entry_type_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_gift_card_ledger_entry_type_check', 'ordering_gift_card_ledger';
    END;
  END IF;
END $mig$;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_card_ledger_operation_idx ON ordering_gift_card_ledger(business,operation_key) WHERE operation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_card_ledger_reversal_idx ON ordering_gift_card_ledger(related_entry_id) WHERE entry_type='reversal';
CREATE INDEX IF NOT EXISTS ordering_gift_card_ledger_business_created_idx ON ordering_gift_card_ledger(business,created_at DESC);
CREATE OR REPLACE FUNCTION ordering_gift_card_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Gift card ledger entries are immutable'; END $$;
DROP TRIGGER IF EXISTS ordering_gift_card_ledger_immutable_trigger ON ordering_gift_card_ledger;
CREATE TRIGGER ordering_gift_card_ledger_immutable_trigger BEFORE UPDATE OR DELETE ON ordering_gift_card_ledger FOR EACH ROW EXECUTE FUNCTION ordering_gift_card_ledger_immutable();

-- src/lib/ordering-item-cancellations.ts:ensureSchema
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ordering_order_items_cancelled_quantity_check') THEN ALTER TABLE ordering_order_items ADD CONSTRAINT ordering_order_items_cancelled_quantity_check CHECK(cancelled_quantity>=0 AND cancelled_quantity<=quantity); END IF; END $$;
CREATE TABLE IF NOT EXISTS ordering_order_item_cancellations(id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,order_item_id UUID NOT NULL REFERENCES ordering_order_items(id),client_mutation_id TEXT,quantity INTEGER NOT NULL CHECK(quantity>0),merchandise_cents INTEGER NOT NULL,discount_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL,refund_cents INTEGER NOT NULL DEFAULT 0,payment_transaction_id UUID REFERENCES ordering_payment_transactions(id),reason TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE ordering_order_item_cancellations ADD COLUMN IF NOT EXISTS client_mutation_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_order_item_cancellations_mutation_idx ON ordering_order_item_cancellations(client_mutation_id) WHERE client_mutation_id IS NOT NULL;

-- src/lib/ordering-labels.ts:ensureSchema
CREATE TABLE IF NOT EXISTS ordering_item_labels(
        order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
        unit_index INTEGER NOT NULL CHECK (unit_index >= 0),
        business TEXT NOT NULL,
        order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
        printer_id UUID REFERENCES ordering_hardware_devices(id),
        print_count INTEGER NOT NULL DEFAULT 1,
        first_printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        printed_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (order_item_id, unit_index));
CREATE INDEX IF NOT EXISTS ordering_item_labels_recent_idx ON ordering_item_labels(business, last_printed_at DESC);

-- src/lib/ordering-loyalty-schema.ts:ensureOrderingLoyaltySchema
ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS customer_label TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS internal_description TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS automatic BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS stackable_with_loyalty BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS exclusive_group TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS gross_base_merchandise_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS modifier_revenue_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS promotion_discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS loyalty_discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS net_merchandise_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS category_name_snapshot TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS ordering_order_promotion_applications (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          promotion_id UUID REFERENCES ordering_promotions(id),
          promotion_version INTEGER NOT NULL,
          label_snapshot TEXT NOT NULL,
          configuration_snapshot JSONB NOT NULL,
          normal_base_subtotal_cents INTEGER NOT NULL CHECK(normal_base_subtotal_cents >= 0),
          discount_cents INTEGER NOT NULL CHECK(discount_cents >= 0),
          resulting_base_subtotal_cents INTEGER NOT NULL CHECK(resulting_base_subtotal_cents >= 0),
          application_sequence INTEGER NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(order_id, application_sequence)
        );
CREATE TABLE IF NOT EXISTS ordering_order_promotion_allocations (
          id UUID PRIMARY KEY,
          application_id UUID NOT NULL REFERENCES ordering_order_promotion_applications(id) ON DELETE CASCADE,
          order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
          consumed_quantity INTEGER NOT NULL CHECK(consumed_quantity > 0),
          normal_base_cents INTEGER NOT NULL CHECK(normal_base_cents >= 0),
          discount_cents INTEGER NOT NULL CHECK(discount_cents >= 0),
          UNIQUE(application_id, order_item_id)
        );
CREATE INDEX IF NOT EXISTS ordering_order_promotions_order_idx ON ordering_order_promotion_applications(order_id, application_sequence);
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_order_promotion_allocations') AND c.conname = 'ordering_order_promotion_allocations_order_item_id_fkey'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:59439c2bbfbb5ea5b1ffd82e103834cf'
  ) THEN
    ALTER TABLE ordering_order_promotion_allocations DROP CONSTRAINT IF EXISTS ordering_order_promotion_allocations_order_item_id_fkey;
    ALTER TABLE ordering_order_promotion_allocations ADD CONSTRAINT ordering_order_promotion_allocations_order_item_id_fkey FOREIGN KEY(order_item_id) REFERENCES ordering_order_items(id) ON DELETE CASCADE NOT VALID;
    COMMENT ON CONSTRAINT ordering_order_promotion_allocations_order_item_id_fkey ON ordering_order_promotion_allocations IS 'corner-ops:59439c2bbfbb5ea5b1ffd82e103834cf';
    BEGIN
      ALTER TABLE ordering_order_promotion_allocations VALIDATE CONSTRAINT ordering_order_promotion_allocations_order_item_id_fkey;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_order_promotion_allocations_order_item_id_fkey', 'ordering_order_promotion_allocations';
    END;
  END IF;
END $mig$;
ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS customer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS stackable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES ordering_order_items(id);
ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS related_event_id UUID REFERENCES ordering_loyalty_ledger(id);
ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_loyalty_ledger') AND c.conname = 'ordering_loyalty_ledger_entry_type_check'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:e8ef1ffaf5d1a23c550edea12887a27e'
  ) THEN
    ALTER TABLE ordering_loyalty_ledger DROP CONSTRAINT IF EXISTS ordering_loyalty_ledger_entry_type_check;
    ALTER TABLE ordering_loyalty_ledger ADD CONSTRAINT ordering_loyalty_ledger_entry_type_check CHECK(entry_type IN ('earn','redeem','void_reversal','redemption_reversal','manager_adjustment','reversal','adjustment','expire')) NOT VALID;
    COMMENT ON CONSTRAINT ordering_loyalty_ledger_entry_type_check ON ordering_loyalty_ledger IS 'corner-ops:e8ef1ffaf5d1a23c550edea12887a27e';
    BEGIN
      ALTER TABLE ordering_loyalty_ledger VALIDATE CONSTRAINT ordering_loyalty_ledger_entry_type_check;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_loyalty_ledger_entry_type_check', 'ordering_loyalty_ledger';
    END;
  END IF;
END $mig$;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_loyalty_earn_progress_idx ON ordering_loyalty_ledger(program_id,order_id,(COALESCE(metadata->>'earnedThroughUnits','legacy'))) WHERE entry_type='earn';
DROP INDEX IF EXISTS ordering_loyalty_earn_once_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_loyalty_reverse_once_idx ON ordering_loyalty_ledger(related_event_id,entry_type) WHERE related_event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ordering_order_loyalty_applications (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          order_item_id UUID NOT NULL REFERENCES ordering_order_items(id),
          customer_id UUID NOT NULL REFERENCES ordering_customers(id),
          program_id UUID NOT NULL REFERENCES ordering_loyalty_programs(id),
          program_version INTEGER NOT NULL,
          label_snapshot TEXT NOT NULL,
          configuration_snapshot JSONB NOT NULL,
          consumed_quantity INTEGER NOT NULL DEFAULT 1 CHECK(consumed_quantity > 0),
          base_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(base_discount_cents >= 0),
          modifier_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(modifier_discount_cents >= 0),
          discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
          redemption_event_id UUID REFERENCES ordering_loyalty_ledger(id),
          requested_by TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(order_id, program_id, order_item_id)
        );
CREATE INDEX IF NOT EXISTS ordering_order_loyalty_order_idx ON ordering_order_loyalty_applications(order_id,applied_at);

-- src/lib/ordering-marketing-schema.ts:ensureOrderingMarketingSchema
CREATE TABLE IF NOT EXISTS ordering_marketing_settings (
            business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            signup_keyword TEXT NOT NULL DEFAULT 'DELI',
            confirmation_keyword TEXT NOT NULL DEFAULT 'YES',
            quiet_start_local TIME NOT NULL DEFAULT '19:00',
            quiet_end_local TIME NOT NULL DEFAULT '10:00',
            timezone TEXT NOT NULL DEFAULT 'America/New_York',
            sender_key TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE TABLE IF NOT EXISTS ordering_marketing_subscriptions (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
            normalized_phone TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'active', 'opted_out', 'blocked')),
            consent_source TEXT NOT NULL
              CHECK (consent_source IN ('sms_keyword', 'web', 'pos', 'ai_phone', 'other')),
            disclosure_snapshot TEXT NOT NULL DEFAULT '',
            consent_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confirmed_at TIMESTAMPTZ,
            opted_out_at TIMESTAMPTZ,
            last_marketing_sent_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, normalized_phone)
          );
CREATE INDEX IF NOT EXISTS ordering_marketing_subscriptions_active_idx ON ordering_marketing_subscriptions (business, status, last_marketing_sent_at);
CREATE INDEX IF NOT EXISTS ordering_marketing_subscriptions_customer_idx ON ordering_marketing_subscriptions (customer_id, status);
CREATE TABLE IF NOT EXISTS ordering_marketing_consent_events (
            id UUID PRIMARY KEY,
            subscription_id UUID NOT NULL REFERENCES ordering_marketing_subscriptions(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL
              CHECK (event_type IN ('signup_requested', 'opt_in_confirmed', 'opt_out', 'blocked', 'resubscribed', 'help_requested')),
            source TEXT NOT NULL DEFAULT '',
            disclosure_snapshot TEXT NOT NULL DEFAULT '',
            evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS ordering_marketing_consent_events_subscription_idx ON ordering_marketing_consent_events (subscription_id, created_at);
CREATE TABLE IF NOT EXISTS ordering_marketing_campaigns (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            name TEXT NOT NULL,
            trigger_type TEXT NOT NULL DEFAULT 'inactivity'
              CHECK (trigger_type IN ('inactivity', 'manual', 'birthday', 'custom')),
            inactivity_days INTEGER NOT NULL DEFAULT 25 CHECK (inactivity_days >= 1),
            one_per_inactivity_episode BOOLEAN NOT NULL DEFAULT TRUE,
            message_template TEXT NOT NULL,
            offer_type TEXT NOT NULL DEFAULT 'item_amount_off'
              CHECK (offer_type IN ('item_amount_off', 'order_amount_off', 'percent_off', 'none')),
            offer_item_id UUID REFERENCES ordering_menu_items(id) ON DELETE SET NULL,
            offer_label TEXT NOT NULL DEFAULT '',
            offer_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (offer_amount_cents >= 0),
            offer_percent_bps INTEGER NOT NULL DEFAULT 0 CHECK (offer_percent_bps >= 0 AND offer_percent_bps <= 10000),
            offer_valid_days INTEGER NOT NULL DEFAULT 14 CHECK (offer_valid_days >= 1),
            active BOOLEAN NOT NULL DEFAULT FALSE,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (business, name)
          );
CREATE INDEX IF NOT EXISTS ordering_marketing_campaigns_active_idx ON ordering_marketing_campaigns (business, active, trigger_type);
CREATE TABLE IF NOT EXISTS ordering_marketing_offers (
            id UUID PRIMARY KEY,
            campaign_id UUID NOT NULL REFERENCES ordering_marketing_campaigns(id) ON DELETE CASCADE,
            subscription_id UUID NOT NULL REFERENCES ordering_marketing_subscriptions(id) ON DELETE CASCADE,
            customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
            code TEXT NOT NULL UNIQUE,
            offer_item_id UUID REFERENCES ordering_menu_items(id) ON DELETE SET NULL,
            offer_label TEXT NOT NULL DEFAULT '',
            offer_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (offer_amount_cents >= 0),
            offer_percent_bps INTEGER NOT NULL DEFAULT 0 CHECK (offer_percent_bps >= 0 AND offer_percent_bps <= 10000),
            issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            redeemed_order_id UUID REFERENCES ordering_orders(id) ON DELETE SET NULL,
            redeemed_at TIMESTAMPTZ,
            voided_at TIMESTAMPTZ,
            CHECK (expires_at > issued_at)
          );
CREATE INDEX IF NOT EXISTS ordering_marketing_offers_subscription_idx ON ordering_marketing_offers (subscription_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS ordering_marketing_offers_open_idx ON ordering_marketing_offers (expires_at) WHERE redeemed_at IS NULL AND voided_at IS NULL;
CREATE TABLE IF NOT EXISTS ordering_marketing_messages (
            id UUID PRIMARY KEY,
            campaign_id UUID NOT NULL REFERENCES ordering_marketing_campaigns(id) ON DELETE CASCADE,
            subscription_id UUID NOT NULL REFERENCES ordering_marketing_subscriptions(id) ON DELETE CASCADE,
            offer_id UUID REFERENCES ordering_marketing_offers(id) ON DELETE SET NULL,
            normalized_phone TEXT NOT NULL,
            trigger_last_order_id UUID REFERENCES ordering_orders(id) ON DELETE SET NULL,
            trigger_last_order_at TIMESTAMPTZ,
            message_text TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'suppressed', 'expired')),
            suppression_reason TEXT NOT NULL DEFAULT '',
            provider_message_id TEXT NOT NULL DEFAULT '',
            queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            sent_at TIMESTAMPTZ,
            delivered_at TIMESTAMPTZ,
            failed_at TIMESTAMPTZ,
            details JSONB NOT NULL DEFAULT '{}'::jsonb
          );
CREATE INDEX IF NOT EXISTS ordering_marketing_messages_queue_idx ON ordering_marketing_messages (status, queued_at);
CREATE INDEX IF NOT EXISTS ordering_marketing_messages_subscription_idx ON ordering_marketing_messages (subscription_id, queued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ordering_marketing_one_winback_per_order_episode
          ON ordering_marketing_messages (campaign_id, subscription_id, trigger_last_order_id)
          WHERE trigger_last_order_id IS NOT NULL;

-- src/lib/ordering-menu-editor-schema.ts:ensureOrderingMenuEditorSchema
CREATE TABLE IF NOT EXISTS ordering_menu_local_fields (
        business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('category','item','variant','modifier_group','modifier_option')),
        entity_id UUID NOT NULL,
        field_name TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(entity_type,entity_id,field_name)
      );
CREATE INDEX IF NOT EXISTS ordering_menu_local_fields_business_idx ON ordering_menu_local_fields(business,entity_type,entity_id);
ALTER TABLE ordering_menu_override_audit ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';

-- src/lib/ordering-remakes.ts:ensureRemakeSchema
ALTER TABLE ordering_delivery_assignments ALTER COLUMN driver_employee_id DROP NOT NULL;
UPDATE ordering_delivery_assignments d SET business=o.business FROM ordering_orders o WHERE o.id=d.order_id AND d.business IS NULL;
UPDATE ordering_delivery_assignments SET status=CASE status WHEN 'assigned' THEN 'ASSIGNED' WHEN 'out_for_delivery' THEN 'EN_ROUTE' WHEN 'delivered' THEN 'DELIVERED' WHEN 'failed' THEN 'DELIVERY_FAILED' WHEN 'returned' THEN 'RETURNED' WHEN 'cancelled' THEN 'CANCELLED' ELSE status END;
ALTER TABLE ordering_delivery_assignments DROP CONSTRAINT IF EXISTS ordering_delivery_assignments_status_check;
ALTER TABLE ordering_delivery_assignments ADD CONSTRAINT ordering_delivery_assignments_status_check CHECK(status IN ('ASSIGNED','READY_FOR_DRIVER','PICKED_UP','EN_ROUTE','ARRIVED','DELIVERED','NO_CONTACT','DELIVERY_FAILED','RETURNED','CANCELLED'));
CREATE TABLE IF NOT EXISTS ordering_manager_remakes (
        id UUID PRIMARY KEY, original_order_id UUID NOT NULL REFERENCES ordering_orders(id),
        remake_order_id UUID NOT NULL UNIQUE REFERENCES ordering_orders(id),
        client_mutation_id UUID NOT NULL UNIQUE, reason TEXT NOT NULL,
        special_item TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- src/lib/ordering-sales-tax.ts:ensureTaxRateHistory
CREATE TABLE IF NOT EXISTS ordering_tax_rate_history(
        id BIGSERIAL PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
        prices_include_tax BOOLEAN NOT NULL,
        delivery_fee_taxable BOOLEAN NOT NULL,
        effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        changed_by TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS ordering_tax_rate_history_idx ON ordering_tax_rate_history(business, effective_at DESC);

-- src/lib/ordering-supplier-costs.ts:ensureSupplierCostSchema
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS free_delivery_over_cents INTEGER;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS delivery_days SMALLINT[] NOT NULL DEFAULT '{}';
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS cutoff_time TEXT NOT NULL DEFAULT '16:00';
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS cutoff_days_before SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS ships_in_days SMALLINT;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS account_number TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS minimum_cases INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_at TIMESTAMPTZ;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_status TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_message TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_products INTEGER;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_code TEXT;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_code_at TIMESTAMPTZ;
ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_requested_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS ordering_supplier_site_searches(
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        query TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
        found INTEGER,
        message TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL DEFAULT '',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ);
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS weekly_usage_override NUMERIC(14,3);
CREATE TABLE IF NOT EXISTS ordering_inventory_requests(
        id UUID PRIMARY KEY,
        business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
        inventory_item_id UUID REFERENCES ordering_inventory_items(id) ON DELETE SET NULL,
        item_text TEXT NOT NULL DEFAULT '',
        quantity NUMERIC(14,3),
        unit TEXT NOT NULL DEFAULT '',
        urgency TEXT NOT NULL DEFAULT 'low' CHECK (urgency IN ('low','out')),
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ordered','dismissed')),
        requested_by UUID REFERENCES employees(id),
        requested_by_name TEXT NOT NULL DEFAULT '',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_at TIMESTAMPTZ,
        CHECK (inventory_item_id IS NOT NULL OR item_text <> ''));
CREATE INDEX IF NOT EXISTS ordering_inventory_requests_open_idx ON ordering_inventory_requests(business,status,requested_at DESC);
CREATE TABLE IF NOT EXISTS ordering_supplier_catalog(
        id UUID PRIMARY KEY,
        supplier_id UUID NOT NULL REFERENCES ordering_inventory_suppliers(id) ON DELETE CASCADE,
        product_key TEXT NOT NULL,
        vendor_sku TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        brand TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        pack_quantity NUMERIC(14,3) NOT NULL CHECK (pack_quantity > 0),
        pack_unit TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (price_cents > 0),
        source TEXT NOT NULL DEFAULT 'paste',
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (supplier_id, product_key));
CREATE TABLE IF NOT EXISTS ordering_supplier_price_history(
        id BIGSERIAL PRIMARY KEY,
        catalog_id UUID NOT NULL REFERENCES ordering_supplier_catalog(id) ON DELETE CASCADE,
        price_cents INTEGER NOT NULL,
        pack_quantity NUMERIC(14,3) NOT NULL,
        pack_unit TEXT NOT NULL,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS ordering_supplier_price_history_idx ON ordering_supplier_price_history(catalog_id,seen_at DESC);
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_keywords TEXT NOT NULL DEFAULT '';
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_max_unit_cost_cents NUMERIC(14,4);
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_min_pack NUMERIC(14,3);
ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_max_pack NUMERIC(14,3);
CREATE TABLE IF NOT EXISTS ordering_inventory_settings(business TEXT PRIMARY KEY, suppliers_seeded_at TIMESTAMPTZ);
ALTER TABLE ordering_inventory_settings ADD COLUMN IF NOT EXISTS case_minimums_set_at TIMESTAMPTZ;

-- src/lib/ordering-tip-schema.ts:ensureOrderingTipSchema
CREATE TABLE IF NOT EXISTS ordering_tip_policies(business TEXT PRIMARY KEY CHECK(business IN('Corner Deli','Tiki')),delivery_policy TEXT NOT NULL DEFAULT 'assigned_driver' CHECK(delivery_policy IN('assigned_driver','order_taker','pool')),counter_policy TEXT NOT NULL DEFAULT 'order_taker' CHECK(counter_policy IN('order_taker','pool')),pool_clocked_in_only BOOLEAN NOT NULL DEFAULT TRUE,updated_by TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ordering_tip_allocations(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),order_id UUID NOT NULL REFERENCES ordering_orders(id),employee_id UUID REFERENCES employees(id),employee_name TEXT NOT NULL DEFAULT '',tender_type TEXT NOT NULL CHECK(tender_type IN('cash','card','gift_card','other')),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),status TEXT NOT NULL DEFAULT 'eligible' CHECK(status IN('unassigned','eligible','paid','reversed')),allocation_reason TEXT NOT NULL DEFAULT '',payout_batch_id UUID,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(order_id,employee_id,tender_type));
CREATE INDEX IF NOT EXISTS ordering_tip_allocations_status_idx ON ordering_tip_allocations(business,status,employee_id);
ALTER TABLE ordering_tip_allocations DROP CONSTRAINT IF EXISTS ordering_tip_allocations_order_id_employee_id_tender_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_tip_allocations_active_unique_idx ON ordering_tip_allocations(order_id,employee_id,tender_type) WHERE status IN('unassigned','eligible');
ALTER TABLE ordering_checks ADD COLUMN IF NOT EXISTS tip_cents INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS ordering_tip_payout_batches(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN('posted','reversed')),total_cents INTEGER NOT NULL DEFAULT 0,employee_count INTEGER NOT NULL DEFAULT 0,period_start DATE,period_end DATE,created_by TEXT NOT NULL,approved_by TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),reversed_at TIMESTAMPTZ);
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('ordering_tip_allocations') AND c.conname = 'ordering_tip_allocations_payout_batch_id_fkey'
      AND COALESCE(obj_description(c.oid, 'pg_constraint'), '') = 'corner-ops:7dd0bc17dfb224df9df4211d52013b43'
  ) THEN
    ALTER TABLE ordering_tip_allocations DROP CONSTRAINT IF EXISTS ordering_tip_allocations_payout_batch_id_fkey;
    ALTER TABLE ordering_tip_allocations ADD CONSTRAINT ordering_tip_allocations_payout_batch_id_fkey FOREIGN KEY(payout_batch_id) REFERENCES ordering_tip_payout_batches(id) NOT VALID;
    COMMENT ON CONSTRAINT ordering_tip_allocations_payout_batch_id_fkey ON ordering_tip_allocations IS 'corner-ops:7dd0bc17dfb224df9df4211d52013b43';
    BEGIN
      ALTER TABLE ordering_tip_allocations VALIDATE CONSTRAINT ordering_tip_allocations_payout_batch_id_fkey;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE WARNING 'Constraint % on % is enforced for new rows but existing rows did not validate.', 'ordering_tip_allocations_payout_batch_id_fkey', 'ordering_tip_allocations';
    END;
  END IF;
END $mig$;

-- src/lib/ordering-voice-payment.ts:ensureVoicePaymentSchema
CREATE TABLE IF NOT EXISTS ordering_voice_payment_sessions(
      id UUID PRIMARY KEY,business TEXT NOT NULL,call_id TEXT NOT NULL,order_id UUID NOT NULL REFERENCES ordering_orders(id),caller_phone TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0),replay_id BIGINT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'awaiting_call',attempt_count INTEGER NOT NULL DEFAULT 0,
      provider_transaction_reference TEXT NOT NULL DEFAULT '',brand TEXT NOT NULL DEFAULT '',last4 TEXT NOT NULL DEFAULT '',failure_code TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ NOT NULL,claimed_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(business,call_id)
    );
CREATE INDEX IF NOT EXISTS ordering_voice_payment_lookup_idx ON ordering_voice_payment_sessions(business,caller_phone,status,created_at DESC);

-- src/lib/payroll-approval.ts:ensurePayrollApprovalSchema
CREATE TABLE IF NOT EXISTS payroll_submissions (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            week_start DATE NOT NULL,
            payroll_run_version_id UUID NOT NULL UNIQUE REFERENCES payroll_run_versions(id),
            status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitting', 'submitted', 'failed', 'cancelled')),
            message TEXT NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0,
            queued_by TEXT NOT NULL DEFAULT '',
            queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            confirmation_emailed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'payroll';
ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS code_at TIMESTAMPTZ;
ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS code_emailed_at TIMESTAMPTZ;
ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS totals JSONB;
ALTER TABLE payroll_submissions ALTER COLUMN payroll_run_version_id DROP NOT NULL;
ALTER TABLE payroll_submissions ALTER COLUMN week_start DROP NOT NULL;
ALTER TABLE payroll_submissions DROP CONSTRAINT IF EXISTS payroll_submissions_status_check;
ALTER TABLE payroll_submissions ADD CONSTRAINT payroll_submissions_status_check
            CHECK (status IN ('queued', 'submitting', 'needs_code', 'submitted', 'sent', 'failed', 'cancelled'));
ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS submit_after_save BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payroll_submissions ADD COLUMN IF NOT EXISTS submit_pressed_at TIMESTAMPTZ;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('payroll_submissions') AND conname = 'payroll_submissions_kind_check') THEN
    ALTER TABLE payroll_submissions ADD CONSTRAINT payroll_submissions_kind_check
            CHECK ((kind = 'payroll' AND payroll_run_version_id IS NOT NULL AND week_start IS NOT NULL) OR kind = 'roster');
  END IF;
END $mig$;
CREATE TABLE IF NOT EXISTS payroll_relief_roster (
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            ee_num TEXT NOT NULL,
            name TEXT NOT NULL,
            pay_type TEXT NOT NULL DEFAULT '',
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (business, ee_num)
          );
CREATE TABLE IF NOT EXISTS payroll_relief_employees (
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            employee_key TEXT NOT NULL,
            employee_name TEXT NOT NULL,
            ee_num TEXT NOT NULL,
            confirmed_by TEXT NOT NULL DEFAULT '',
            confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (business, employee_key)
          );
CREATE INDEX IF NOT EXISTS payroll_submissions_status_idx ON payroll_submissions (status, queued_at);
CREATE INDEX IF NOT EXISTS payroll_submissions_week_idx ON payroll_submissions (business, week_start DESC);
CREATE TABLE IF NOT EXISTS payroll_week_notices (
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            week_start DATE NOT NULL,
            kind TEXT NOT NULL,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (business, week_start, kind)
          );
CREATE TABLE IF NOT EXISTS payroll_week_holds (
            business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
            week_start DATE NOT NULL,
            held_by TEXT NOT NULL,
            held_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            released_by TEXT,
            released_at TIMESTAMPTZ,
            PRIMARY KEY (business, week_start)
          );

-- src/lib/pizza-gauntlet/server.ts:ensureGauntletSchema
CREATE TABLE IF NOT EXISTS pizza_gauntlet_runs(id UUID PRIMARY KEY,token_hash TEXT NOT NULL,player_name TEXT NOT NULL DEFAULT 'Anonymous Cook',status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','won','lost','abandoned')),stage INTEGER NOT NULL DEFAULT 1,stage_orders INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT 0,active_seconds INTEGER NOT NULL DEFAULT 0,stats JSONB NOT NULL DEFAULT '{}'::jsonb,checkpoints JSONB NOT NULL DEFAULT '[]'::jsonb,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ);
ALTER TABLE pizza_gauntlet_runs ADD COLUMN IF NOT EXISTS game_version TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS pizza_gauntlet_runs_board_idx ON pizza_gauntlet_runs(status,completed_at DESC);
CREATE TABLE IF NOT EXISTS pizza_gauntlet_rewards(id UUID PRIMARY KEY,run_id UUID NOT NULL UNIQUE REFERENCES pizza_gauntlet_runs(id),code TEXT NOT NULL UNIQUE,prize_type TEXT NOT NULL,terms JSONB NOT NULL,completion_stats JSONB NOT NULL,issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ,redeemed_at TIMESTAMPTZ,redeemed_by TEXT,redemption_note TEXT NOT NULL DEFAULT '');

-- src/lib/pos-auth.ts:ensurePosAuthSchema
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pos_role TEXT NOT NULL DEFAULT 'employee';
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_pos_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_pos_role_check CHECK (pos_role IN ('employee','manager','owner'));
CREATE TABLE IF NOT EXISTS pos_pin_attempts (
        attempt_key TEXT PRIMARY KEY,
        failed_count INTEGER NOT NULL DEFAULT 0,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

-- src/lib/pos-network-access.ts:ensurePosNetworkSchema
CREATE TABLE IF NOT EXISTS pos_network_access_requests(id UUID PRIMARY KEY,ip_address TEXT NOT NULL,requester_note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN('pending','approved','denied')),requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),reviewed_at TIMESTAMPTZ,reviewed_by TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS pos_network_pending_ip_idx ON pos_network_access_requests(ip_address) WHERE status='pending';
CREATE TABLE IF NOT EXISTS pos_network_allowlist(ip_address TEXT PRIMARY KEY,label TEXT NOT NULL DEFAULT '',approved_request_id UUID REFERENCES pos_network_access_requests(id),approved_by TEXT NOT NULL,approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),active BOOLEAN NOT NULL DEFAULT TRUE);

-- src/lib/push-notifications.ts:ensurePushSchema
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT '';

-- src/lib/rate-limit.ts:ensureRateLimitSchema
CREATE TABLE IF NOT EXISTS security_rate_limits (
            scope TEXT NOT NULL,
            discriminator_hash TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            blocked_until TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (scope, discriminator_hash)
          );
CREATE INDEX IF NOT EXISTS security_rate_limits_blocked_idx
          ON security_rate_limits (blocked_until)
          WHERE blocked_until IS NOT NULL;

-- src/lib/restaurant-platform.ts:ensureRestaurantPlatformSchema
CREATE TABLE IF NOT EXISTS restaurant_concepts(id UUID PRIMARY KEY,concept_key TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,legacy_business TEXT NOT NULL CHECK(legacy_business IN('Corner Deli','Tiki')),service_model TEXT NOT NULL CHECK(service_model IN('quick_service','bar','table_service')),active BOOLEAN NOT NULL DEFAULT TRUE,branding JSONB NOT NULL DEFAULT '{}'::jsonb,features JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS restaurant_locations(id UUID PRIMARY KEY,concept_id UUID NOT NULL REFERENCES restaurant_concepts(id),location_key TEXT NOT NULL,name TEXT NOT NULL,timezone TEXT NOT NULL DEFAULT 'America/New_York',active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(concept_id,location_key));
CREATE TABLE IF NOT EXISTS restaurant_floor_plans(id UUID PRIMARY KEY,location_id UUID NOT NULL REFERENCES restaurant_locations(id),name TEXT NOT NULL,width INTEGER NOT NULL DEFAULT 1200 CHECK(width BETWEEN 320 AND 4000),height INTEGER NOT NULL DEFAULT 800 CHECK(height BETWEEN 320 AND 4000),active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(location_id,name));
CREATE TABLE IF NOT EXISTS restaurant_sections(id UUID PRIMARY KEY,floor_plan_id UUID NOT NULL REFERENCES restaurant_floor_plans(id) ON DELETE CASCADE,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT '#355c7d',sort_order INTEGER NOT NULL DEFAULT 0,active BOOLEAN NOT NULL DEFAULT TRUE,UNIQUE(floor_plan_id,name));
CREATE TABLE IF NOT EXISTS restaurant_tables(id UUID PRIMARY KEY,floor_plan_id UUID NOT NULL REFERENCES restaurant_floor_plans(id) ON DELETE CASCADE,section_id UUID REFERENCES restaurant_sections(id),table_number TEXT NOT NULL,label TEXT NOT NULL,seats INTEGER NOT NULL DEFAULT 4 CHECK(seats BETWEEN 1 AND 50),shape TEXT NOT NULL DEFAULT 'rectangle' CHECK(shape IN('rectangle','round','booth','bar_seat')),x INTEGER NOT NULL DEFAULT 40,y INTEGER NOT NULL DEFAULT 40,width INTEGER NOT NULL DEFAULT 120,height INTEGER NOT NULL DEFAULT 80,active BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(floor_plan_id,table_number));
CREATE TABLE IF NOT EXISTS restaurant_table_sessions(id UUID PRIMARY KEY,table_id UUID NOT NULL REFERENCES restaurant_tables(id),order_id UUID REFERENCES ordering_orders(id),server_id TEXT NOT NULL,server_name TEXT NOT NULL,guest_count INTEGER NOT NULL CHECK(guest_count BETWEEN 1 AND 99),status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','ordering','sent','paying','closed','transferred')),opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),closed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_table_one_open_session_idx ON restaurant_table_sessions(table_id) WHERE status IN('open','ordering','sent','paying');
CREATE TABLE IF NOT EXISTS restaurant_course_fires(id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES ordering_orders(id),course_number INTEGER NOT NULL CHECK(course_number BETWEEN 1 AND 20),status TEXT NOT NULL CHECK(status IN('held','fired')),fired_by TEXT,fired_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(order_id,course_number));

-- src/lib/rezku-product-sales.ts:ensureRezkuProductSalesSchema
CREATE TABLE IF NOT EXISTS rezku_product_sales_import_batches (
            id UUID PRIMARY KEY,
            business TEXT NOT NULL DEFAULT 'Corner Deli' CHECK (business = 'Corner Deli'),
            report_type TEXT NOT NULL DEFAULT 'sales_by_product' CHECK (report_type = 'sales_by_product'),
            business_date DATE NOT NULL,
            file_name TEXT NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            imported_by TEXT NOT NULL,
            imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS rezku_product_sales_batches_date_idx ON rezku_product_sales_import_batches (business_date DESC, imported_at DESC);
CREATE TABLE IF NOT EXISTS rezku_product_sales (
            id UUID PRIMARY KEY,
            source_key TEXT NOT NULL UNIQUE,
            batch_id UUID NOT NULL REFERENCES rezku_product_sales_import_batches(id) ON DELETE CASCADE,
            business_date DATE NOT NULL,
            category TEXT NOT NULL DEFAULT '',
            product TEXT NOT NULL,
            list_price NUMERIC(14,4) NOT NULL DEFAULT 0,
            average_price NUMERIC(14,4) NOT NULL DEFAULT 0,
            quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
            sales NUMERIC(14,2) NOT NULL DEFAULT 0,
            percent_sales NUMERIC(14,8) NOT NULL DEFAULT 0,
            average_profit NUMERIC(14,4) NOT NULL DEFAULT 0,
            profit NUMERIC(14,2) NOT NULL DEFAULT 0,
            percent_profit NUMERIC(14,8) NOT NULL DEFAULT 0,
            raw JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS rezku_product_sales_date_idx ON rezku_product_sales (business_date DESC);
CREATE INDEX IF NOT EXISTS rezku_product_sales_product_idx ON rezku_product_sales (product, business_date DESC);
CREATE INDEX IF NOT EXISTS rezku_product_sales_category_idx ON rezku_product_sales (category, business_date DESC);

-- src/lib/screen-auth.ts:ensureSchema
CREATE TABLE IF NOT EXISTS ordering_store_screens(
        id UUID PRIMARY KEY,
        business TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('board','labels')),
        name TEXT NOT NULL,
        signed_in_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ);

-- src/lib/square-control.ts:ensureSquareControlSchema
CREATE INDEX IF NOT EXISTS square_orders_date_idx ON square_orders (created_at_square DESC, state);
CREATE TABLE IF NOT EXISTS square_order_lines (
        id UUID PRIMARY KEY,
        square_order_id UUID NOT NULL REFERENCES square_orders(id) ON DELETE CASCADE,
        external_line_id TEXT NOT NULL,
        catalog_object_id TEXT NOT NULL DEFAULT '',
        item_name TEXT NOT NULL DEFAULT '',
        variation_name TEXT NOT NULL DEFAULT '',
        quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
        gross_sales NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_tax NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_discount NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_money NUMERIC(14,2) NOT NULL DEFAULT 0,
        modifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (square_order_id, external_line_id)
      );
CREATE INDEX IF NOT EXISTS square_order_lines_catalog_idx ON square_order_lines (catalog_object_id);
CREATE TABLE IF NOT EXISTS square_catalog_objects (
        id UUID PRIMARY KEY,
        connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        external_object_id TEXT NOT NULL UNIQUE,
        object_type TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        parent_catalog_id TEXT NOT NULL DEFAULT '',
        variation_of_id TEXT NOT NULL DEFAULT '',
        sku TEXT NOT NULL DEFAULT '',
        price NUMERIC(14,2) NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at_square TIMESTAMPTZ,
        version BIGINT,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS square_catalog_type_idx ON square_catalog_objects (object_type, active, name);
CREATE TABLE IF NOT EXISTS square_inventory_counts (
        id UUID PRIMARY KEY,
        connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        catalog_object_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'IN_STOCK',
        quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
        calculated_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (catalog_object_id, location_id, state)
      );
CREATE INDEX IF NOT EXISTS square_inventory_location_idx ON square_inventory_counts (location_id, state, quantity);
CREATE TABLE IF NOT EXISTS square_webhook_events (
        id UUID PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        merchant_id TEXT NOT NULL DEFAULT '',
        location_id TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'Received' CHECK (status IN ('Received', 'Processed', 'Ignored', 'Failed')),
        error TEXT NOT NULL DEFAULT '',
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );
CREATE INDEX IF NOT EXISTS square_webhook_events_received_idx ON square_webhook_events (received_at DESC, status);

-- src/lib/three-cx-live-calls.ts:ensureThreeCxLiveCallSchema
CREATE TABLE IF NOT EXISTS three_cx_live_calls(id UUID PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,call_id TEXT NOT NULL,caller_phone TEXT NOT NULL,queue_number TEXT NOT NULL DEFAULT '',line_number TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'ringing',started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),acknowledged_at TIMESTAMPTZ,acknowledged_by TEXT,raw JSONB NOT NULL DEFAULT '{}'::jsonb);
CREATE INDEX IF NOT EXISTS three_cx_live_calls_active_idx ON three_cx_live_calls(status,updated_at DESC);

-- src/lib/three-cx-missed-call-messages.ts:ensureNotificationSchema
CREATE TABLE IF NOT EXISTS three_cx_missed_call_notifications (
            id UUID PRIMARY KEY,
            history_id TEXT NOT NULL UNIQUE,
            dropped_at TIMESTAMPTZ NOT NULL,
            caller TEXT NOT NULL DEFAULT '',
            wait_seconds INTEGER NOT NULL DEFAULT 0,
            recipient_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

-- src/lib/weather-intelligence.ts:ensureWeatherSchema
CREATE TABLE IF NOT EXISTS weather_daily (
            weather_date DATE PRIMARY KEY,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('Historical', 'Forecast')),
            weather_code INTEGER NOT NULL DEFAULT 0,
            temperature_max_f NUMERIC(8,2) NOT NULL DEFAULT 0,
            temperature_min_f NUMERIC(8,2) NOT NULL DEFAULT 0,
            temperature_mean_f NUMERIC(8,2) NOT NULL DEFAULT 0,
            apparent_temperature_max_f NUMERIC(8,2) NOT NULL DEFAULT 0,
            precipitation_in NUMERIC(10,3) NOT NULL DEFAULT 0,
            rain_in NUMERIC(10,3) NOT NULL DEFAULT 0,
            snowfall_in NUMERIC(10,3) NOT NULL DEFAULT 0,
            precipitation_probability INTEGER NOT NULL DEFAULT 0,
            wind_max_mph NUMERIC(8,2) NOT NULL DEFAULT 0,
            wind_gust_mph NUMERIC(8,2) NOT NULL DEFAULT 0,
            sunshine_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
CREATE INDEX IF NOT EXISTS weather_daily_source_idx ON weather_daily (source_kind, weather_date);


-- src/lib/employee-auth.ts (device sessions) and src/lib/employee-pin-audit.ts
CREATE TABLE IF NOT EXISTS employee_app_sessions (
  id UUID PRIMARY KEY, employee_id UUID NOT NULL REFERENCES employees(id), business TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
  authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS employee_pin_audit (
  id UUID PRIMARY KEY, employee_id UUID NOT NULL REFERENCES employees(id), business TEXT NOT NULL,
  action TEXT NOT NULL, actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

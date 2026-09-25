-- Bank-feed behavior is installed by a migration, never by a GET/POST request.
CREATE OR REPLACE FUNCTION corner_ops_filter_inactive_bank_account()
    RETURNS TRIGGER AS $$
    DECLARE
      account_is_active BOOLEAN;
    BEGIN
      SELECT active INTO account_is_active
      FROM public.bank_accounts
      WHERE connection_id = NEW.connection_id
        AND external_account_id = NEW.external_account_id
      LIMIT 1;

      IF account_is_active = FALSE THEN
        NEW.review_status := 'Ignored';
        NEW.user_override := TRUE;
        NEW.classification_source := 'Excluded bank account';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_transactions_active_account_filter ON public.bank_transactions;
CREATE TRIGGER bank_transactions_active_account_filter
BEFORE INSERT OR UPDATE ON public.bank_transactions
FOR EACH ROW EXECUTE FUNCTION public.corner_ops_filter_inactive_bank_account();


-- From src/lib/employee-handbook.ts
CREATE UNIQUE INDEX IF NOT EXISTS employee_handbook_ack_employee_hash_unique ON employee_handbook_acknowledgments (employee_id, handbook_version, content_hash);

-- From src/lib/finance-operations-schema.ts
CREATE UNIQUE INDEX IF NOT EXISTS vendor_bills_invoice_unique ON vendor_bills (business, LOWER(vendor), invoice_number) WHERE invoice_number <> '' AND status <> 'Void';

-- From src/lib/employee-directory.ts
CREATE UNIQUE INDEX IF NOT EXISTS employees_business_email_unique
        ON employees (business, LOWER(email))
        WHERE email <> '';

-- From src/lib/employee-directory.ts
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

-- From src/lib/employee-directory.ts
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

-- From src/lib/overtime-risk.ts
CREATE OR REPLACE FUNCTION corner_ops_log_schedule_shift_change()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
          old_name TEXT := '';
          new_name TEXT := '';
          kind TEXT := '';
          prior_employee UUID := NULL;
          prior_start TIMESTAMPTZ := NULL;
          prior_end TIMESTAMPTZ := NULL;
          prior_status TEXT := NULL;
        BEGIN
          IF TG_OP = 'UPDATE' THEN
            IF OLD.employee_id IS NOT DISTINCT FROM NEW.employee_id
               AND OLD.starts_at IS NOT DISTINCT FROM NEW.starts_at
               AND OLD.ends_at IS NOT DISTINCT FROM NEW.ends_at
               AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
              RETURN NEW;
            END IF;
            prior_employee := OLD.employee_id;
            prior_start := OLD.starts_at;
            prior_end := OLD.ends_at;
            prior_status := OLD.status;
          END IF;

          IF TG_OP = 'INSERT' THEN
            kind := CASE WHEN NEW.employee_id IS NULL THEN 'Created open shift' ELSE 'Created assignment' END;
          ELSIF prior_employee IS DISTINCT FROM NEW.employee_id THEN
            kind := CASE
              WHEN prior_employee IS NULL THEN 'Assigned open shift'
              WHEN NEW.employee_id IS NULL THEN 'Unassigned shift'
              ELSE 'Reassigned shift'
            END;
          ELSIF prior_start IS DISTINCT FROM NEW.starts_at OR prior_end IS DISTINCT FROM NEW.ends_at THEN
            kind := 'Changed shift time';
          ELSE
            kind := 'Changed shift status';
          END IF;

          IF prior_employee IS NOT NULL THEN
            SELECT name INTO old_name FROM employees WHERE id = prior_employee;
          END IF;
          IF NEW.employee_id IS NOT NULL THEN
            SELECT name INTO new_name FROM employees WHERE id = NEW.employee_id;
          END IF;

          INSERT INTO shift_change_log (
            id, business, shift_id, change_type, prior_employee_id, prior_employee_name,
            new_employee_id, new_employee_name, starts_at, ends_at, details
          ) VALUES (
            gen_random_uuid(), NEW.business, NEW.id, kind,
            prior_employee, COALESCE(old_name, ''), NEW.employee_id, COALESCE(new_name, ''),
            NEW.starts_at, NEW.ends_at,
            jsonb_build_object(
              'priorStartsAt', prior_start,
              'priorEndsAt', prior_end,
              'priorStatus', prior_status,
              'newStatus', NEW.status,
              'position', NEW.position
            )
          );
          RETURN NEW;
        END;
        $$;;

-- From src/lib/expense-control.ts
CREATE UNIQUE INDEX IF NOT EXISTS card_transfer_active_bank_unique
        ON credit_card_transfer_matches (bank_transaction_id)
        WHERE status <> 'Ignored';

-- From src/lib/expense-control.ts
CREATE UNIQUE INDEX IF NOT EXISTS card_transfer_active_card_unique
        ON credit_card_transfer_matches (card_transaction_id)
        WHERE status <> 'Ignored';

-- From src/lib/expense-control.ts
CREATE UNIQUE INDEX IF NOT EXISTS receipt_active_document_unique
        ON receipt_transaction_matches (receipt_id)
        WHERE status <> 'Ignored';

-- From src/lib/expense-control.ts
CREATE UNIQUE INDEX IF NOT EXISTS receipt_active_transaction_unique
        ON receipt_transaction_matches (bank_transaction_id)
        WHERE status = 'Matched';

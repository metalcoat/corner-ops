-- Baseline public functions. Generated from validated production catalog.

CREATE OR REPLACE FUNCTION public.corner_ops_filter_inactive_bank_account()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    DECLARE
      account_is_active BOOLEAN;
    BEGIN
      SELECT active INTO account_is_active
      FROM bank_accounts
      WHERE external_account_id = NEW.external_account_id
      LIMIT 1;

      IF account_is_active = FALSE THEN
        NEW.review_status := 'Ignored';
        NEW.user_override := TRUE;
        NEW.classification_source := 'Excluded bank account';
      END IF;

      RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.corner_ops_log_schedule_shift_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
        $function$
;

CREATE OR REPLACE FUNCTION public.corner_ops_prepare_rezku_employee()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
        $function$
;

CREATE OR REPLACE FUNCTION public.corner_ops_sync_rezku_employee()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
        $function$
;

CREATE OR REPLACE FUNCTION public.enforce_stage2_journal_balance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_entry UUID := COALESCE(NEW.entry_id, OLD.entry_id);
  entry_source TEXT;
  debit_total NUMERIC(14,2);
  credit_total NUMERIC(14,2);
BEGIN
  SELECT source INTO entry_source FROM journal_entries WHERE id = target_entry;
  IF NOT FOUND OR entry_source NOT IN ('Bank Import', 'Credit Card Import', 'Square', 'Reversal') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO debit_total, credit_total
  FROM journal_lines
  WHERE entry_id = target_entry;

  IF ABS(debit_total - credit_total) > 0.005 THEN
    RAISE EXCEPTION 'Journal entry % is out of balance: debit %, credit %', target_entry, debit_total, credit_total;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.show_db_tree()
 RETURNS TABLE(tree_structure text)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT ':file_folder: ' || datname || ' (DATABASE)'
    FROM pg_database
    WHERE datistemplate = false;

    RETURN QUERY
    WITH RECURSIVE
    schemas AS (
        SELECT n.nspname AS object_name, 1 AS level, n.nspname AS path, 'SCHEMA' AS object_type
        FROM pg_namespace n
        WHERE n.nspname NOT LIKE 'pg_%'
        AND n.nspname != 'information_schema'
    ),
    objects AS (
        SELECT c.relname AS object_name, 2 AS level, s.path || ' → ' || c.relname AS path,
            CASE c.relkind
                WHEN 'r' THEN 'TABLE'
                WHEN 'v' THEN 'VIEW'
                WHEN 'm' THEN 'MATERIALIZED VIEW'
                WHEN 'i' THEN 'INDEX'
                WHEN 'S' THEN 'SEQUENCE'
                WHEN 'f' THEN 'FOREIGN TABLE'
            END AS object_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN schemas s ON n.nspname = s.object_name
        WHERE c.relkind IN ('r','v','m','i','S','f')
        UNION ALL
        SELECT p.proname AS object_name, 2 AS level, s.path || ' → ' || p.proname AS path, 'FUNCTION' AS object_type
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN schemas s ON n.nspname = s.object_name
    ),
    combined AS (
        SELECT * FROM schemas
        UNION ALL
        SELECT * FROM objects
    )
    SELECT
        REPEAT('    ', level) ||
        CASE
            WHEN level = 1 THEN '└── :open_file_folder: '
            ELSE '    └── ' ||
                CASE object_type
                    WHEN 'TABLE' THEN ':bar_chart: '
                    WHEN 'VIEW' THEN ':eye: '
                    WHEN 'MATERIALIZED VIEW' THEN ':newspaper: '
                    WHEN 'FUNCTION' THEN ':zap: '
                    WHEN 'INDEX' THEN ':mag: '
                    WHEN 'SEQUENCE' THEN ':1234: '
                    WHEN 'FOREIGN TABLE' THEN ':globe_with_meridians: '
                    ELSE ''
                END
        END || object_name || ' (' || object_type || ')'
    FROM combined
    ORDER BY path;
END;
$function$
;

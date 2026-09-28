-- Run only against the disposable CI database. All fixture changes roll back.
BEGIN;
CREATE FUNCTION pg_temp.check_true(value boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Assertion failed: %', message; END IF; END $$;
INSERT INTO public.employees (id, business, name, pin_hash, pin_enabled)
VALUES ('eeeeeeee-0000-4000-8000-000000000001', 'Tiki', 'Audit Test Employee', 'synthetic', true);

DO $$
DECLARE
  employee uuid := 'eeeeeeee-0000-4000-8000-000000000001';
  first_receipt jsonb; second_receipt jsonb; old_entry uuid; new_entry uuid;
BEGIN
  first_receipt := public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000001', 'clock-in', NULL, NULL, NULL, NULL, 'Location was not supplied.');
  old_entry := (first_receipt->'entry'->>'id')::uuid;
  PERFORM pg_temp.check_true(first_receipt->>'action' = 'clocked-in', 'explicit clock-in');
  second_receipt := public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000001', 'clock-in', NULL, 1, 1, 1, '');
  PERFORM pg_temp.check_true(second_receipt->>'replayed' = 'true' AND second_receipt->'entry' = first_receipt->'entry', 'same key replays exact original receipt');
  PERFORM pg_temp.check_true((SELECT count(*) = 1 FROM public.time_entries WHERE employee_id = employee), 'only one clock-in row');
  first_receipt := public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000002', 'clock-out', old_entry, NULL, NULL, NULL, '');
  second_receipt := public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000002', 'clock-out', old_entry, NULL, NULL, NULL, '');
  PERFORM pg_temp.check_true(second_receipt->'entry' = first_receipt->'entry', 'lost clock-out response replays exact receipt');
  PERFORM pg_temp.check_true(NOT EXISTS(SELECT 1 FROM public.time_entries WHERE employee_id = employee AND clock_out IS NULL), 'retry does not clock employee back in');
  first_receipt := public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000003', 'clock-in', old_entry, 1, 1, 1, '');
  new_entry := (first_receipt->'entry'->>'id')::uuid;
  PERFORM pg_temp.check_true(new_entry IS NOT NULL AND new_entry <> old_entry, 'new deliberate shift allowed');
  PERFORM public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000002', 'clock-out', old_entry, NULL, NULL, NULL, '');
  PERFORM public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000004', 'clock-out', old_entry, NULL, NULL, NULL, '');
  PERFORM pg_temp.check_true((SELECT clock_out IS NULL FROM public.time_entries WHERE id = new_entry), 'old clock-out cannot close newer shift, even under different key');
  second_receipt := public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000002', 'clock-out', new_entry, NULL, NULL, NULL, '');
  PERFORM pg_temp.check_true(second_receipt->>'code' = 'PUNCH_REQUEST_CONFLICT', 'key reuse with a different target rejected');
  second_receipt := public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000005', 'clock-in', old_entry, NULL, NULL, NULL, '');
  PERFORM pg_temp.check_true(second_receipt->>'code' = 'PUNCH_STATE_CHANGED', 'stale clock-in rejected');
  PERFORM public.corner_ops_punch_tiki(employee, 'aaaaaaaa-0000-4000-8000-000000000006', 'clock-out', new_entry, NULL, NULL, NULL, '');
END $$;

-- Force the replay-ledger write to fail after the primary punch would have changed.
CREATE FUNCTION pg_temp.reject_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Injected receipt persistence failure'; END $$;
CREATE TRIGGER audit_reject_receipt BEFORE INSERT ON public.timeclock_punch_requests
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_test_receipt();
DO $$
DECLARE latest_entry uuid; before_rows integer;
BEGIN
  SELECT id INTO latest_entry FROM public.time_entries WHERE employee_id = 'eeeeeeee-0000-4000-8000-000000000001' ORDER BY clock_in DESC LIMIT 1;
  SELECT count(*) INTO before_rows FROM public.time_entries WHERE employee_id = 'eeeeeeee-0000-4000-8000-000000000001';
  BEGIN
    PERFORM public.corner_ops_punch_tiki('eeeeeeee-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000007', 'clock-in', latest_entry, NULL, NULL, NULL, '');
    RAISE EXCEPTION 'Expected injected receipt failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Injected receipt persistence failure' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.check_true((SELECT count(*) = before_rows FROM public.time_entries WHERE employee_id = 'eeeeeeee-0000-4000-8000-000000000001'), 'receipt failure rolls back punch too');
END $$;
DROP TRIGGER audit_reject_receipt ON public.timeclock_punch_requests;

-- Exercise historical duplicate cleanup in a transaction where the unique index is absent.
DROP INDEX public.one_open_time_entry_per_employee;
INSERT INTO public.time_entries(id, business, employee_id, employee_name, position, role_group, clock_in)
VALUES
('dddddddd-0000-4000-8000-000000000001', 'Tiki', 'eeeeeeee-0000-4000-8000-000000000001', 'Audit Test Employee', 'Bartender', 'In-House', now()-interval '3 hours'),
('dddddddd-0000-4000-8000-000000000002', 'Tiki', 'eeeeeeee-0000-4000-8000-000000000001', 'Audit Test Employee', 'Bartender', 'In-House', now()-interval '2 hours');
CREATE FUNCTION pg_temp.reject_stale_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.id = 'dddddddd-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'Injected stale cleanup failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER audit_reject_cleanup BEFORE UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_stale_cleanup();
SELECT public.corner_ops_punch_tiki('eeeeeeee-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000008', 'clock-out', 'dddddddd-0000-4000-8000-000000000002', NULL, NULL, NULL, '');
SELECT pg_temp.check_true((SELECT clock_out IS NOT NULL FROM public.time_entries WHERE id = 'dddddddd-0000-4000-8000-000000000002'), 'cleanup failure preserves primary clock-out');
SELECT pg_temp.check_true(EXISTS(SELECT 1 FROM public.timeclock_punch_requests WHERE request_id = 'aaaaaaaa-0000-4000-8000-000000000008'), 'cleanup failure preserves receipt');
ROLLBACK;

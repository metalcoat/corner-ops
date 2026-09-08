-- A punch and its replayable receipt commit together in one transaction.
CREATE TABLE IF NOT EXISTS public.timeclock_punch_requests (
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('clock-in', 'clock-out')),
  expected_entry_id uuid,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, request_id)
);

CREATE OR REPLACE FUNCTION public.corner_ops_punch_tiki(
  p_employee_id uuid, p_request_id uuid, p_action text, p_entry_id uuid,
  p_lat numeric, p_lng numeric, p_accuracy numeric, p_review text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public
AS $$
DECLARE
  person public.employees%ROWTYPE;
  prior public.timeclock_punch_requests%ROWTYPE;
  latest public.time_entries%ROWTYPE;
  punch public.time_entries%ROWTYPE;
  receipt jsonb;
  long_shift boolean;
  duplicate_count integer := 0;
  punch_time timestamptz;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL OR p_action NOT IN ('clock-in', 'clock-out') THEN
    RAISE EXCEPTION 'Explicit punch action and request ID are required.' USING ERRCODE = '22023';
  END IF;
  -- Serialize all punch decisions for this employee until receipt + row commit.
  PERFORM pg_advisory_xact_lock(hashtextextended('corner-ops:tiki:' || p_employee_id::text, 0));
  SELECT * INTO person FROM public.employees
  WHERE id = p_employee_id AND business = 'Tiki' AND active AND pin_enabled FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'PUNCH_UNAUTHORIZED', 'error', 'Active Tiki employee sign-in is required.');
  END IF;

  SELECT * INTO prior FROM public.timeclock_punch_requests
  WHERE employee_id = p_employee_id AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.action <> p_action OR prior.expected_entry_id IS DISTINCT FROM p_entry_id THEN
      RETURN jsonb_build_object('code', 'PUNCH_REQUEST_CONFLICT', 'error', 'This request ID belongs to a different punch.');
    END IF;
    RETURN prior.response || jsonb_build_object('replayed', true);
  END IF;

  punch_time := clock_timestamp();
  IF p_action = 'clock-out' THEN
    -- Target the actual shift. A delayed clock-out can never close a later shift.
    IF p_entry_id IS NULL THEN
      RETURN jsonb_build_object('code', 'PUNCH_STATE_CHANGED', 'error', 'Refresh the clock before clocking out.');
    END IF;
    SELECT * INTO punch FROM public.time_entries
    WHERE id = p_entry_id AND business = 'Tiki' AND employee_id = p_employee_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('code', 'PUNCH_STATE_CHANGED', 'error', 'The selected shift was not found. Refresh the clock.');
    END IF;
    IF punch.clock_out IS NULL THEN
      long_shift := punch_time - punch.clock_in > interval '16 hours';
      UPDATE public.time_entries SET
        clock_out = GREATEST(punch_time, clock_in),
        clock_out_lat = p_lat, clock_out_lng = p_lng, clock_out_accuracy = p_accuracy,
        status = CASE WHEN status = 'Needs Review' OR COALESCE(p_review, '') <> '' OR long_shift
          THEN 'Needs Review' ELSE 'Complete' END,
        notes = CONCAT_WS(' ', NULLIF(notes, ''), NULLIF(p_review, ''),
          CASE WHEN long_shift THEN 'Shift exceeded 16 hours before clock-out.' END),
        updated_at = punch_time
      WHERE id = punch.id AND business = 'Tiki' AND employee_id = p_employee_id AND clock_out IS NULL
      RETURNING * INTO punch;
      IF NOT FOUND THEN RAISE EXCEPTION 'Primary clock-out update returned no row.'; END IF;
      BEGIN
        -- Only older duplicates, never a new shift created after this target.
        UPDATE public.time_entries SET
          clock_out = GREATEST(punch_time, clock_in), status = 'Corrected', updated_at = punch_time,
          notes = CONCAT_WS(' ', NULLIF(notes, ''), 'Automatically closed stale duplicate open punch during clock-out.')
        WHERE business = 'Tiki' AND employee_id = p_employee_id
          AND id <> punch.id AND clock_out IS NULL AND clock_in <= punch.clock_in;
        GET DIAGNOSTICS duplicate_count = ROW_COUNT;
      EXCEPTION WHEN OTHERS THEN
        -- This subtransaction rolls back cleanup only, not the primary punch.
        RAISE WARNING 'Primary clock-out saved but stale duplicate cleanup failed';
      END;
    END IF;
  ELSE
    SELECT * INTO latest FROM public.time_entries
    WHERE business = 'Tiki' AND employee_id = p_employee_id
    ORDER BY (clock_out IS NULL) DESC, clock_in DESC, created_at DESC, id DESC LIMIT 1 FOR UPDATE;
    IF latest.id IS DISTINCT FROM p_entry_id OR (latest.id IS NOT NULL AND latest.clock_out IS NULL) THEN
      RETURN jsonb_build_object('code', 'PUNCH_STATE_CHANGED', 'error', 'Your clock status changed. Refresh before recording a new punch.');
    END IF;
    INSERT INTO public.time_entries (
      id, business, employee_id, employee_name, position, role_group,
      clock_in, clock_in_lat, clock_in_lng, clock_in_accuracy, status, notes
    ) VALUES (
      gen_random_uuid(), 'Tiki', person.id, person.name, person.position, person.role_group,
      punch_time, p_lat, p_lng, p_accuracy,
      CASE WHEN COALESCE(p_review, '') <> '' THEN 'Needs Review' ELSE 'Open' END, COALESCE(p_review, '')
    ) RETURNING * INTO punch;
  END IF;

  receipt := jsonb_build_object(
    'requestId', p_request_id, 'action', CASE WHEN p_action = 'clock-in' THEN 'clocked-in' ELSE 'clocked-out' END,
    'employee', person.name,
    'entry', jsonb_build_object('id', punch.id, 'clock_in', punch.clock_in, 'clock_out', punch.clock_out, 'status', punch.status),
    'locationReview', NULLIF(p_review, ''), 'duplicateOpenPunchesClosed', duplicate_count, 'replayed', false
  );
  INSERT INTO public.timeclock_punch_requests (employee_id, request_id, action, expected_entry_id, response)
  VALUES (p_employee_id, p_request_id, p_action, p_entry_id, receipt);
  RETURN receipt;
END;
$$;
-- Use the application's database role, not public/anonymous SQL execution.
REVOKE ALL ON FUNCTION public.corner_ops_punch_tiki(uuid, uuid, text, uuid, numeric, numeric, numeric, text) FROM PUBLIC;

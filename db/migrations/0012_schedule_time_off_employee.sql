-- The regular employee taken off a shift for their time off (shift reassigned, opened or cancelled),
-- so copying the week gives the shift back to them instead of copying the day off.
ALTER TABLE public.schedule_shifts
  ADD COLUMN IF NOT EXISTS time_off_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL;

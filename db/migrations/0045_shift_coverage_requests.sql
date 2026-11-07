-- "I need coverage": an employee's own shift sent to the whole team. A coworker taps "I'll take it"
-- (target_employee_id, employee_response 'Accepted') and a manager approves the hand-over.
ALTER TABLE shift_requests
  ADD COLUMN IF NOT EXISTS coverage_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_call_out boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sick_leave boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS shift_requests_open_coverage_idx
  ON shift_requests (business, created_at DESC) WHERE coverage_requested_at IS NOT NULL AND status = 'Pending';

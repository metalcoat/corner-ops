-- An owner marks a new-hire checklist step as done after checking it themselves (e.g. paper documents
-- seen in person). A bypassed step counts as done everywhere, including the "can be scheduled" check.
CREATE TABLE IF NOT EXISTS employee_onboarding_waivers (
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  business text NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  step_key text NOT NULL,
  waived_by text NOT NULL,
  waived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, step_key)
);

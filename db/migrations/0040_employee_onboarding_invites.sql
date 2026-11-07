-- New-hire self-setup links. "Add employee" creates the employee with no PIN and texts one
-- personal link (/employee/welcome/<token>). Only a SHA-256 of the token is stored; a resend
-- revokes the older link. The new hire chooses their own PIN on that page.
CREATE TABLE IF NOT EXISTS employee_onboarding_invites (
  id uuid PRIMARY KEY,
  business text NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  opened_at timestamptz,
  account_set_at timestamptz,
  sms_status text NOT NULL DEFAULT 'pending',
  sms_detail text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS employee_onboarding_invites_employee_idx
  ON employee_onboarding_invites (business, employee_id, created_at DESC);

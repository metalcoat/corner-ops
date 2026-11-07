-- "Schedule app" step: set the first time a new hire signs in with their PIN from the app or
-- Employee Hub (POST /api/employee/session), not from their setup link. Works without
-- employee_app_sessions, which production does not have.
ALTER TABLE employee_onboarding_invites ADD COLUMN IF NOT EXISTS app_signed_in_at timestamptz;

-- Daily "your setup isn't finished" texts to new hires (at most 7, from the day after the first
-- setup text). One row per employee so a resent link doesn't restart the count.
CREATE TABLE IF NOT EXISTS employee_onboarding_reminders (
  employee_id uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  business text NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  reminders_sent integer NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  last_status text NOT NULL DEFAULT '',
  last_detail text NOT NULL DEFAULT ''
);

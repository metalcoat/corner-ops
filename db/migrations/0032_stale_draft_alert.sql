-- Stale draft alert: a staff order never sent to the kitchen pops up on the back POS after 10 minutes idle.
-- created_station is the POS station that rang it; '' = not recorded (before 2026-10-30, or a device with no station).
ALTER TABLE ordering_orders
  ADD COLUMN IF NOT EXISTS created_station text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft_alert_snoozed_until timestamptz;

-- Minutes of no activity before the alert (0 = off) and which stations show it. Settings → Operations.
ALTER TABLE ordering_business_settings
  ADD COLUMN IF NOT EXISTS stale_draft_alert_minutes integer NOT NULL DEFAULT 10 CHECK (stale_draft_alert_minutes BETWEEN 0 AND 240),
  ADD COLUMN IF NOT EXISTS stale_draft_alert_stations text[] NOT NULL DEFAULT '{deli-back-1}';

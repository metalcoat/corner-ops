-- Databases the app built for itself before the migrations existed (dev) have some tables in an
-- older shape: the table was already there, so the baseline's CREATE TABLE never added these
-- columns, and IF NOT EXISTS kept the older defaults. Bring them in line with a database built
-- from the migration files. Each statement is a no-op where it already matches (production).

ALTER TABLE bank_transaction_splits ADD COLUMN IF NOT EXISTS invoice_id uuid;

ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS meal_break_start timestamp with time zone;
ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS meal_break_minutes integer DEFAULT 0 NOT NULL;
ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS extra_meal_break_start timestamp with time zone;
ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS extra_meal_break_minutes integer DEFAULT 0 NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ordering_modifier_presentation_overrides'::regclass
      AND conname = 'ordering_modifier_presentation_overrides_behavior_check'
  ) THEN
    ALTER TABLE ordering_modifier_presentation_overrides
      ADD CONSTRAINT ordering_modifier_presentation_overrides_behavior_check
      CHECK (behavior IN ('standard', 'pizza_topping'));
  END IF;
END $$;

ALTER TABLE ordering_business_settings ALTER COLUMN online_order_alert_sound SET DEFAULT 'warm_chime';
ALTER TABLE ordering_business_settings ALTER COLUMN online_order_alert_volume SET DEFAULT 65;
ALTER TABLE ordering_ai_phone_settings ALTER COLUMN model SET DEFAULT 'gpt-realtime-1.5';

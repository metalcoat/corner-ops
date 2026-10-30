-- Closeout count by denomination (pennies … $100 bills) plus a checks total. The POS works out
-- which bills and coins to leave in the till for its reset amount; the rest is the deposit.
ALTER TABLE ordering_register_sessions
  ADD COLUMN IF NOT EXISTS counted_denominations jsonb,
  ADD COLUMN IF NOT EXISTS counted_checks_cents integer CHECK (counted_checks_cents IS NULL OR counted_checks_cents >= 0),
  ADD COLUMN IF NOT EXISTS reset_plan jsonb;

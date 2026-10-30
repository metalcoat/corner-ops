-- Till reset confirmation: after the close count, staff must confirm the till was reset to its
-- reset amount (front $100, back $0 by default) before the closeout finishes. The next opening
-- uses that confirmed amount, so nobody has to work out whether the till was left at $100 or $0.
-- reset_cash_cents NULL = the default for the till's name (see src/lib/till-reset-rules.ts).
ALTER TABLE ordering_pos_terminals ADD COLUMN IF NOT EXISTS reset_cash_cents integer CHECK (reset_cash_cents IS NULL OR reset_cash_cents >= 0);

ALTER TABLE ordering_register_sessions
  ADD COLUMN IF NOT EXISTS reset_expected_cents integer,
  ADD COLUMN IF NOT EXISTS reset_confirmed_cents integer CHECK (reset_confirmed_cents IS NULL OR reset_confirmed_cents >= 0),
  ADD COLUMN IF NOT EXISTS reset_confirmed_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reset_confirmed_by_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reset_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reset_note text NOT NULL DEFAULT '';

-- New 'resetting' step between the count and 'closed'; it still counts as the till's active session.
ALTER TABLE ordering_register_sessions DROP CONSTRAINT IF EXISTS ordering_register_sessions_status_check;
ALTER TABLE ordering_register_sessions ADD CONSTRAINT ordering_register_sessions_status_check CHECK (status IN ('open', 'counting', 'needs_review', 'resetting', 'closed'));
DROP INDEX IF EXISTS ordering_one_active_register_per_terminal;
CREATE UNIQUE INDEX ordering_one_active_register_per_terminal ON ordering_register_sessions (terminal_id) WHERE status IN ('open', 'counting', 'needs_review', 'resetting');

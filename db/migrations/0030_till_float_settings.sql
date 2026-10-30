-- Per-till float and change bag settings (POS Settings → Tills): for each allowed bill/coin a target,
-- minimum and limit, e.g. front $100 = quarters/$1/$5/$10, back $0 plus a $60 change bag.
-- NULL = the defaults for the till's name (src/lib/till-reset-rules.ts). Replaces reset_cash_cents (0028).
ALTER TABLE ordering_pos_terminals ADD COLUMN IF NOT EXISTS till_settings jsonb;
ALTER TABLE ordering_pos_terminals DROP COLUMN IF EXISTS reset_cash_cents;

-- The change bag is counted at closeout and made back up to its target; recorded with the session.
ALTER TABLE ordering_register_sessions
  ADD COLUMN IF NOT EXISTS bag_counted_denominations jsonb,
  ADD COLUMN IF NOT EXISTS bag_confirmed_cents integer CHECK (bag_confirmed_cents IS NULL OR bag_confirmed_cents >= 0);

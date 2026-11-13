-- A modifier group can carry one fee that is charged once when any of its options is picked, however many
-- (Chris 2026-11-06, burger "Deluxe": lettuce, tomato, onion, any or all +$0.25). 0 = no group fee.
-- The fee is stored on the first selected option's order snapshot, so receipts and totals add up as before.
ALTER TABLE ordering_modifier_groups ADD COLUMN IF NOT EXISTS selection_charge_cents integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ordering_modifier_groups_selection_charge_check') THEN
    ALTER TABLE ordering_modifier_groups ADD CONSTRAINT ordering_modifier_groups_selection_charge_check CHECK (selection_charge_cents >= 0);
  END IF;
END $$;

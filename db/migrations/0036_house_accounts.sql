-- House accounts (charge to account / running tab). The tables came with the runtime schema (0014) but nothing
-- used them; this adds what the POS charge, the manager portal and the printed statement need.
-- Balance = SUM(delta_balance_cents): charges add, payments / credits / reversals subtract.
ALTER TABLE ordering_house_accounts
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;
-- Two people can share a name; only open accounts need distinct names, so a closed one can be recreated.
ALTER TABLE ordering_house_accounts DROP CONSTRAINT IF EXISTS ordering_house_accounts_business_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS ordering_house_accounts_open_name_idx
  ON ordering_house_accounts (business, lower(name)) WHERE status <> 'closed';

-- Who, where and how for every tab entry: the employee's name, the register/device a charge was rung on,
-- and how a payment was made (cash, check, card).
ALTER TABLE ordering_house_account_ledger
  ADD COLUMN IF NOT EXISTS business text NOT NULL DEFAULT 'Corner Deli',
  ADD COLUMN IF NOT EXISTS actor_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS station_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_label text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS related_entry_id uuid REFERENCES ordering_house_account_ledger(id),
  ADD COLUMN IF NOT EXISTS balance_after_cents integer;
-- One charge per POS payment, one reversal per reversal transaction.
CREATE UNIQUE INDEX IF NOT EXISTS ordering_house_account_ledger_payment_once_idx
  ON ordering_house_account_ledger (payment_transaction_id, entry_type) WHERE payment_transaction_id IS NOT NULL;

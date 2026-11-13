-- More than one payment register per business: the front register has the card terminal, the back register keys
-- cards in and has its own cash drawer. Each payment register keeps its own till (shared_register_key).
DROP INDEX IF EXISTS ordering_one_payment_station_idx;

-- An order-taking register sends checks to this payment register ('' = the only payment register, or any of them).
ALTER TABLE ordering_payment_stations ADD COLUMN IF NOT EXISTS payment_station_key TEXT NOT NULL DEFAULT '';

-- The payment register a queued check was sent to ('' = shown on every payment register).
ALTER TABLE ordering_payment_station_queue ADD COLUMN IF NOT EXISTS target_station_key TEXT NOT NULL DEFAULT '';

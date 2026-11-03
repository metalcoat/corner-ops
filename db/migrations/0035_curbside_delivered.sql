-- Curbside: staff tap "Delivered to car" on the POS once the order is brought out. Records who and when;
-- the arrival then stops being listed and the store PC's curbside popup closes.
ALTER TABLE ordering_curbside_arrivals
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_by_id text,
  ADD COLUMN IF NOT EXISTS delivered_by_name text;

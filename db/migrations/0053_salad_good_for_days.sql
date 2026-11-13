-- How many days a deli salad is good for (Chris, 2026-11-09). The checklist screen always shows a "Salads in the
-- case" table (when the current batch was made, how old it is, who made it); with this set, a salad turns amber on
-- its last good day and red once past it. Empty = no highlight.
ALTER TABLE deli_salads ADD COLUMN IF NOT EXISTS good_for_days integer;
ALTER TABLE deli_salads DROP CONSTRAINT IF EXISTS deli_salads_good_for_days_check;
ALTER TABLE deli_salads ADD CONSTRAINT deli_salads_good_for_days_check CHECK (good_for_days IS NULL OR good_for_days BETWEEN 1 AND 30);

-- The fryers are the left and right ones (Chris, 2026-11-09). Renamed in place, so their oil history stays.
UPDATE store_fryers SET name = 'Left fryer', updated_by = 'seed', updated_at = now() WHERE business = 'Corner Deli' AND name = 'Fryer 1';
UPDATE store_fryers SET name = 'Right fryer', updated_by = 'seed', updated_at = now() WHERE business = 'Corner Deli' AND name = 'Fryer 2';

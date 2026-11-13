-- Fryer oil log (Chris, 2026-11-09): one card per fryer on the checklist screen's Salads & fryers tab; staff tap
-- "Oil changed / filled", type their PIN, and who + when is kept. Managers rename or add fryers in the editor.
CREATE TABLE IF NOT EXISTS store_fryers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_fryers_business_idx ON store_fryers (business, position);

CREATE TABLE IF NOT EXISTS store_fryer_oil_changes (
  id bigserial PRIMARY KEY,
  business text NOT NULL,
  business_date date NOT NULL,
  fryer_id uuid NOT NULL REFERENCES store_fryers(id) ON DELETE CASCADE,
  -- The name when it was logged, so history reads right after a rename.
  fryer_name text NOT NULL,
  employee_id text NOT NULL,
  employee_name text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by_name text,
  void_reason text
);
CREATE INDEX IF NOT EXISTS store_fryer_oil_changes_day_idx ON store_fryer_oil_changes (business, business_date, changed_at DESC);
CREATE INDEX IF NOT EXISTS store_fryer_oil_changes_fryer_idx ON store_fryer_oil_changes (fryer_id, changed_at DESC) WHERE voided_at IS NULL;
-- Each salad's latest batch, for the "last made" cards.
CREATE INDEX IF NOT EXISTS deli_salad_batches_salad_idx ON deli_salad_batches (salad_id, made_at DESC) WHERE voided_at IS NULL;

INSERT INTO store_fryers (business, name, position, updated_by)
SELECT 'Corner Deli', seed.name, seed.position, 'seed'
FROM (VALUES ('Fryer 1', 10), ('Fryer 2', 20)) AS seed(name, position)
WHERE NOT EXISTS (SELECT 1 FROM store_fryers WHERE business = 'Corner Deli');

-- Chris confirmed the last two placeholder jobs (2026-11-09).
UPDATE store_checklist_items SET label = 'Stock containers and lids',
  how_to = 'Up front: 8, 16 and 32 oz deli containers with lids. In the back: 2 oz and 4 oz containers with lids, plus takeout containers.',
  placeholder = false, updated_by = 'seed', updated_at = now()
WHERE business = 'Corner Deli' AND label = 'Stock containers up front and by fryer' AND placeholder;
UPDATE store_checklist_items SET how_to = 'Make it exactly as the directions on the back of the bag say.',
  placeholder = false, updated_by = 'seed', updated_at = now()
WHERE business = 'Corner Deli' AND label = 'Brown gravy' AND placeholder;

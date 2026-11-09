-- Store checklists and the deli salad log (Chris, 2026-11-08): the in-store screen /pos/checklists shows the
-- Opening / Mid-day / Closing lists and one button per deli salad. Each tick and each salad batch records who
-- (employee PIN) and when; lists start over each 4 AM business day. Managers edit lists, items and salads in
-- POS Settings or the manager portal; history is in the manager portal (src/lib/store-checklists.ts).
-- An item or list that is switched off keeps its rows; archived_at says from when it stopped counting as missed.

-- The checklist screen keeps its own always-on pass, like the status board and label station.
ALTER TABLE ordering_store_screens DROP CONSTRAINT IF EXISTS ordering_store_screens_kind_check;
ALTER TABLE ordering_store_screens ADD CONSTRAINT ordering_store_screens_kind_check CHECK (kind IN ('board', 'labels', 'checklists'));

CREATE TABLE IF NOT EXISTS store_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  -- The screen opens on the list whose hour has most recently passed (business day, 4 = 4 AM … 27 = 3 AM).
  opens_at_hour integer NOT NULL DEFAULT 4 CHECK (opens_at_hour BETWEEN 4 AND 27),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_checklists_business_idx ON store_checklists (business, position);

CREATE TABLE IF NOT EXISTS store_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL REFERENCES store_checklists(id) ON DELETE CASCADE,
  business text NOT NULL,
  label text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  -- Seeded wording waiting for the store's own; shown with a "placeholder" tag in the editors.
  placeholder boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_checklist_items_list_idx ON store_checklist_items (checklist_id, position);

-- One row per tick. Un-checking keeps the row and records who, when and why.
CREATE TABLE IF NOT EXISTS store_checklist_checks (
  id bigserial PRIMARY KEY,
  business text NOT NULL,
  business_date date NOT NULL,
  checklist_id uuid NOT NULL REFERENCES store_checklists(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES store_checklist_items(id) ON DELETE CASCADE,
  -- The wording when it was ticked, so history reads right after an item is renamed.
  item_label text NOT NULL,
  employee_id text NOT NULL,
  employee_name text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  -- Ticked with "Mark the rest done" rather than one by one.
  bulk boolean NOT NULL DEFAULT false,
  undone_at timestamptz,
  undone_by_id text,
  undone_by_name text,
  undo_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS store_checklist_checks_open_idx ON store_checklist_checks (item_id, business_date) WHERE undone_at IS NULL;
CREATE INDEX IF NOT EXISTS store_checklist_checks_day_idx ON store_checklist_checks (business, business_date);

CREATE TABLE IF NOT EXISTS deli_salads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  placeholder boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deli_salads_business_idx ON deli_salads (business, position);

CREATE TABLE IF NOT EXISTS deli_salad_batches (
  id bigserial PRIMARY KEY,
  business text NOT NULL,
  business_date date NOT NULL,
  salad_id uuid NOT NULL REFERENCES deli_salads(id) ON DELETE CASCADE,
  salad_name text NOT NULL,
  employee_id text NOT NULL,
  employee_name text NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now(),
  batch_size text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  voided_at timestamptz,
  voided_by_name text,
  void_reason text
);
CREATE INDEX IF NOT EXISTS deli_salad_batches_day_idx ON deli_salad_batches (business, business_date, made_at DESC);

-- Placeholder lists, items and salads for Chris to replace (only on a store with none yet).
INSERT INTO store_checklists (business, name, position, opens_at_hour, updated_by)
SELECT 'Corner Deli', seed.name, seed.position, seed.opens_at_hour, 'seed'
FROM (VALUES ('Opening', 10, 4), ('Mid-day', 20, 13), ('Closing', 30, 19)) AS seed(name, position, opens_at_hour)
WHERE NOT EXISTS (SELECT 1 FROM store_checklists WHERE business = 'Corner Deli');

INSERT INTO store_checklist_items (checklist_id, business, label, position, placeholder, updated_by)
SELECT list.id, 'Corner Deli', seed.label, seed.position, true, 'seed'
FROM (VALUES
  ('Opening', 'Turn on fryers and ovens', 10),
  ('Opening', 'Count and open the till', 20),
  ('Opening', 'Check walk-in and cooler temps', 30),
  ('Opening', 'Check dates on deli salads', 40),
  ('Opening', 'Stock the line', 50),
  ('Opening', 'Unlock doors and turn on the open sign', 60),
  ('Mid-day', 'Restock napkins, cups and lids', 10),
  ('Mid-day', 'Wipe tables and counters', 20),
  ('Mid-day', 'Empty trash if full', 30),
  ('Mid-day', 'Restock the line for dinner', 40),
  ('Closing', 'Mop up front', 10),
  ('Closing', 'Mop the kitchen', 20),
  ('Closing', 'Clean the slicer', 30),
  ('Closing', 'Wipe down tables', 40),
  ('Closing', 'Take out the trash', 50),
  ('Closing', 'Clean fryers and filter oil', 60),
  ('Closing', 'Wrap and date all food', 70),
  ('Closing', 'Sweep', 80),
  ('Closing', 'Restock drinks', 90),
  ('Closing', 'Lock doors', 100)
) AS seed(list_name, label, position)
JOIN store_checklists list ON list.business = 'Corner Deli' AND list.name = seed.list_name AND list.updated_by = 'seed'
WHERE NOT EXISTS (SELECT 1 FROM store_checklist_items WHERE business = 'Corner Deli');

-- The four come from the menu's Deli Salads; Tuna and Chicken salad are guesses.
INSERT INTO deli_salads (business, name, position, placeholder, updated_by)
SELECT 'Corner Deli', seed.name, seed.position, seed.placeholder, 'seed'
FROM (VALUES
  ('Macaroni salad', 10, false),
  ('Potato salad', 20, false),
  ('Pasta salad', 30, false),
  ('Cole slaw', 40, false),
  ('Tuna salad', 50, true),
  ('Chicken salad', 60, true)
) AS seed(name, position, placeholder)
WHERE NOT EXISTS (SELECT 1 FROM deli_salads WHERE business = 'Corner Deli');

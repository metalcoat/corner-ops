-- Rest of the salad limits (Chris, 2026-11-09): Pasta, Green Bean and Antipasto good for 7 days, Brown Bean 10
-- (Macaroni, Potato and Cole Slaw got 3 in 0055). Only fills salads with no limit yet.
UPDATE deli_salads SET good_for_days = limits.days, updated_by = 'seed', updated_at = now()
FROM (VALUES ('Pasta', 7), ('Green Bean', 7), ('Antipasto', 7), ('Brown Bean', 10)) AS limits(name, days)
WHERE deli_salads.business = 'Corner Deli' AND deli_salads.name = limits.name AND deli_salads.good_for_days IS NULL;

-- "Make today" for a counted thing by size (pizza dough): each size's minimum on hand; the size left blank takes
-- the rest of the batch. batch_yield is kept for later (Chris will weigh a batch so its exact yield is known);
-- nothing reads it yet.
CREATE TABLE IF NOT EXISTS store_count_plans (
  business text NOT NULL,
  count_key text NOT NULL,
  minimums jsonb NOT NULL DEFAULT '{}'::jsonb,
  leftover_size text NOT NULL DEFAULT '',
  batch_yield jsonb,
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business, count_key)
);

INSERT INTO store_count_plans (business, count_key, minimums, leftover_size, updated_by)
VALUES ('Corner Deli', 'pizza-dough', '{"Small": 10, "Regular": 10, "Thick": 5}'::jsonb, 'Jumbo', 'seed')
ON CONFLICT (business, count_key) DO NOTHING;

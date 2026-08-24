-- CO-074: share the Corner Deli wallboard 3CX report cache across serverless instances
-- and move the wallboard's default task seed out of cold request paths.
CREATE TABLE IF NOT EXISTS deli_board_call_cache (
  work_date DATE PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deli_board_call_cache_expires_idx
  ON deli_board_call_cache (expires_at);

INSERT INTO deli_wallboard_tasks (id, title, category, sort_order, created_by)
VALUES
  (gen_random_uuid(), 'Make sub rolls', 'Prep', 1, 'System'),
  (gen_random_uuid(), 'Make hamburger buns', 'Prep', 2, 'System'),
  (gen_random_uuid(), 'Thaw meats for antipasta', 'Prep', 3, 'System'),
  (gen_random_uuid(), 'Thaw pizza sausage', 'Prep', 4, 'System'),
  (gen_random_uuid(), 'Thaw ground beef', 'Prep', 5, 'System'),
  (gen_random_uuid(), 'Portion chili', 'Prep', 6, 'System'),
  (gen_random_uuid(), 'Prepare nacho cheese / chips', 'Prep', 7, 'System'),
  (gen_random_uuid(), 'Fill wing sauce bottles', 'Line', 8, 'System'),
  (gen_random_uuid(), 'Fill pizza prep table', 'Line', 9, 'System'),
  (gen_random_uuid(), 'Fill dressing bottles', 'Line', 10, 'System'),
  (gen_random_uuid(), 'Prep sub tomatoes', 'Produce', 11, 'System'),
  (gen_random_uuid(), 'Julienne tomatoes', 'Produce', 12, 'System'),
  (gen_random_uuid(), 'Prep salad vegetables', 'Produce', 13, 'System'),
  (gen_random_uuid(), 'Prep celery for wings', 'Produce', 14, 'System'),
  (gen_random_uuid(), 'Prep salad lettuce', 'Produce', 15, 'System'),
  (gen_random_uuid(), 'Check olives', 'Stock', 16, 'System'),
  (gen_random_uuid(), 'Cook / stock bacon', 'Stock', 17, 'System'),
  (gen_random_uuid(), 'Check and stir front salads', 'Salads', 18, 'System'),
  (gen_random_uuid(), 'Boil macaroni', 'Salads', 19, 'System'),
  (gen_random_uuid(), 'Boil pasta', 'Salads', 20, 'System'),
  (gen_random_uuid(), 'Prepare antipasta', 'Salads', 21, 'System'),
  (gen_random_uuid(), 'Prepare coleslaw', 'Salads', 22, 'System'),
  (gen_random_uuid(), 'Prepare brown beans', 'Sides', 23, 'System'),
  (gen_random_uuid(), 'Prepare green beans', 'Sides', 24, 'System'),
  (gen_random_uuid(), 'Clean steam table', 'Cleaning', 25, 'System'),
  (gen_random_uuid(), 'Empty freezer tray / cooler water', 'Cleaning', 26, 'System')
ON CONFLICT (title) DO NOTHING;

-- A short note shown under a menu section's heading on the online menu
-- ("Our sub rolls and burger buns are baked fresh in the store every day.").
ALTER TABLE ordering_category_overrides ADD COLUMN IF NOT EXISTS description text;

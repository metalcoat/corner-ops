-- Names customers actually use, from 2,232 deli phone calls (Sep 1 to Nov 8 2026, redacted transcripts; Chris
-- approved 2026-11-09). The POS, online ordering and the AI phone all search these alias tables.
-- Matched by name (ids differ between dev and production); ON CONFLICT keeps it safe to run again.
WITH wanted(item_name, category_name, alias) AS (
  VALUES
    ('Steak', 'Subs/Wraps', 'Philly'),
    ('Steak', 'Subs/Wraps', 'Philly steak'),
    ('Steak', 'Subs/Wraps', 'Philly steak and cheese'),
    ('Steak', 'Subs/Wraps', 'Philly cheesesteak'),
    ('Steak', 'Subs/Wraps', 'cheesesteak'),
    ('Steak', 'Subs/Wraps', 'cheese steak'),
    ('Steak', 'Subs/Wraps', 'steak and cheese'),
    ('Cheesy Breadsticks', NULL, 'cheesy garlic bread'),
    ('Cheesy Breadsticks', NULL, 'garlic cheesy bread'),
    ('Cheesy Breadsticks', NULL, 'cheese bread'),
    ('Cheesy Breadsticks', NULL, 'cheesy bread'),
    ('Cheesy Breadsticks', NULL, 'cheese breadsticks'),
    ('Mac Salad', 'Deli Salads', 'macaroni salad'),
    ('Mac Salad', 'Deli Salads', 'macaroni'),
    ('Cole Slaw', 'Deli Salads', 'coleslaw'),
    ('Cole Slaw', 'Deli Salads', 'slaw')
)
INSERT INTO ordering_menu_item_aliases (id, item_id, alias, normalized_alias, active)
SELECT gen_random_uuid(), item.id, wanted.alias,
       trim(regexp_replace(replace(lower(wanted.alias), '&', ' and '), '[^a-z0-9]+', ' ', 'g')), TRUE
FROM wanted
JOIN ordering_menu_items item ON item.business = 'Corner Deli' AND item.name = wanted.item_name AND item.active
JOIN ordering_menu_categories category ON category.id = item.category_id
WHERE wanted.category_name IS NULL OR category.name = wanted.category_name
ON CONFLICT (item_id, normalized_alias) DO NOTHING;

-- "A whole steak", "half a turkey": the sub sizes.
WITH wanted(variant_name, alias) AS (
  VALUES ('Full Sub', 'whole'), ('Full Sub', 'whole sub'), ('1/2 Sub', 'half'), ('1/2 Sub', 'half sub')
)
INSERT INTO ordering_menu_variant_aliases (id, variant_id, alias, normalized_alias, active)
SELECT gen_random_uuid(), variant.id, wanted.alias, wanted.alias, TRUE
FROM wanted
JOIN ordering_menu_item_variants variant ON variant.name = wanted.variant_name AND variant.active
JOIN ordering_menu_items item ON item.id = variant.item_id AND item.business = 'Corner Deli' AND item.active
ON CONFLICT (variant_id, normalized_alias) DO NOTHING;

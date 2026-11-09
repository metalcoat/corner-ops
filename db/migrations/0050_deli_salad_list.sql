-- The real deli salad list (Chris, 2026-11-09): Macaroni, Potato, Pasta, Green Bean, Brown Bean, Cole Slaw,
-- Antipasto, in that order. Renames the salads 0049 seeded (batches keep their link), adds the missing ones and
-- takes off the Tuna and Chicken salad guesses: deleted when no batch was logged for them, switched off otherwise.
UPDATE deli_salads SET name = fix.name, position = fix.position, placeholder = false, archived_at = NULL, updated_by = 'seed', updated_at = now()
FROM (VALUES
  ('Macaroni salad', 'Macaroni', 10),
  ('Potato salad', 'Potato', 20),
  ('Pasta salad', 'Pasta', 30),
  ('Cole slaw', 'Cole Slaw', 60)
) AS fix(old_name, name, position)
WHERE deli_salads.business = 'Corner Deli' AND deli_salads.name = fix.old_name
  AND NOT EXISTS (SELECT 1 FROM deli_salads taken WHERE taken.business = 'Corner Deli' AND taken.name = fix.name);

INSERT INTO deli_salads (business, name, position, placeholder, updated_by)
SELECT 'Corner Deli', seed.name, seed.position, false, 'seed'
FROM (VALUES ('Macaroni', 10), ('Potato', 20), ('Pasta', 30), ('Green Bean', 40), ('Brown Bean', 50), ('Cole Slaw', 60), ('Antipasto', 70)) AS seed(name, position)
WHERE NOT EXISTS (SELECT 1 FROM deli_salads existing WHERE existing.business = 'Corner Deli' AND existing.name = seed.name);

DELETE FROM deli_salads
WHERE business = 'Corner Deli' AND name IN ('Tuna salad', 'Chicken salad')
  AND NOT EXISTS (SELECT 1 FROM deli_salad_batches batch WHERE batch.salad_id = deli_salads.id);

UPDATE deli_salads SET archived_at = COALESCE(archived_at, now()), updated_by = 'seed', updated_at = now()
WHERE business = 'Corner Deli' AND name IN ('Tuna salad', 'Chicken salad');

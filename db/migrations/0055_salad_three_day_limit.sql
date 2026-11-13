-- Macaroni, Potato and Cole Slaw are good for 3 days (Chris, 2026-11-09): amber in the "Salads in the case"
-- table on the third day, red after. Only sets salads that have no limit yet, so a manager's own setting stays.
UPDATE deli_salads SET good_for_days = 3, updated_by = 'seed', updated_at = now()
WHERE business = 'Corner Deli' AND name IN ('Macaroni', 'Potato', 'Cole Slaw') AND good_for_days IS NULL;

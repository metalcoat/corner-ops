-- Chris (2026-11-06): gravy can go on the fries, including a hot meat meal's fry side. This turns the
-- "Gravy on Fries" Fry Option back on (hidden 2026-10-28 with nacho cheese; nacho cheese stays on the side).
-- Plain "gravy" still means Gravy on Side; "on the fries" / "on top" means Gravy on Fries.
-- Only rows that are still off are changed, and each change is audited, so rerunning it does nothing.
WITH reopened AS (
  UPDATE ordering_modifier_options option
  SET active = TRUE, available = TRUE, updated_at = NOW()
  FROM ordering_modifier_groups grp
  WHERE grp.id = option.group_id
    AND grp.business = 'Corner Deli'
    AND grp.name = 'Fry Option'
    AND option.name = 'Gravy on Fries'
    AND (option.active = FALSE OR option.available = FALSE)
  RETURNING option.id
)
INSERT INTO ordering_menu_override_audit (id, business, actor_id, target_type, target_id, field_name, previous_value, new_value, reason)
SELECT gen_random_uuid(), 'Corner Deli', 'migration-0037', 'modifier_option', reopened.id, 'restore',
  '{"active": false}'::jsonb, '{"active": true}'::jsonb,
  'Chris 2026-11-06: gravy can go on the fries (incl. hot meat meal fries); nacho cheese stays on the side'
FROM reopened;

-- Pizza dough is counted by size (Chris, 2026-11-09): Small, Regular, Jumbo and Thick, each with On hand and Made,
-- at Opening (Made today), Mid-day and Closing (Made this shift). The fields are "Size · Column", which the
-- checklist screen shows as a grid. Earlier single-number dough counts stay as they were saved.
UPDATE store_checklist_items item SET count_fields = ARRAY[
    'Small · On hand', 'Small · ' || made.label, 'Regular · On hand', 'Regular · ' || made.label,
    'Jumbo · On hand', 'Jumbo · ' || made.label, 'Thick · On hand', 'Thick · ' || made.label
  ]::text[],
  how_to = CASE list.name
    WHEN 'Opening' THEN 'Count the dough on hand for each size at the start of the shift, then how many of each you made. Leave Made blank if none.'
    WHEN 'Closing' THEN 'End of the night: count the dough on hand for each size, and how many of each were made this shift.'
    ELSE 'Count the dough on hand for each size, and how many of each were made this shift.' END,
  updated_by = 'seed', updated_at = now()
FROM store_checklists list,
  LATERAL (SELECT CASE WHEN list.name = 'Opening' THEN 'Made today' ELSE 'Made this shift' END AS label) made
WHERE list.id = item.checklist_id AND item.business = 'Corner Deli' AND item.count_key = 'pizza-dough';

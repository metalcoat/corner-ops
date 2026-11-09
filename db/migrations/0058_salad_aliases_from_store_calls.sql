-- 0057's Mac Salad / Cole Slaw aliases named the category "Deli Salads"; it is "Salads & Deli / Deli Salads".
WITH wanted(item_name, alias) AS (
  VALUES ('Mac Salad', 'macaroni salad'), ('Mac Salad', 'macaroni'), ('Cole Slaw', 'coleslaw'), ('Cole Slaw', 'slaw')
)
INSERT INTO ordering_menu_item_aliases (id, item_id, alias, normalized_alias, active)
SELECT gen_random_uuid(), item.id, wanted.alias, wanted.alias, TRUE
FROM wanted
JOIN ordering_menu_items item ON item.business = 'Corner Deli' AND item.name = wanted.item_name AND item.active
JOIN ordering_menu_categories category ON category.id = item.category_id AND category.name = 'Salads & Deli / Deli Salads'
ON CONFLICT (item_id, normalized_alias) DO NOTHING;

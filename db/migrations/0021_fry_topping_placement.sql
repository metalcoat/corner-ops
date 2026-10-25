-- Explicit topping options retain the configured side price and print unambiguously.
INSERT INTO ordering_modifier_options (id,group_id,name,price_delta_cents,available,active,sort_order)
SELECT gen_random_uuid(), option.group_id, replace(option.name,' on Side',' on Fries'), option.price_delta_cents,option.available,option.active,option.sort_order+1
FROM ordering_modifier_options option JOIN ordering_modifier_groups grp ON grp.id=option.group_id
WHERE grp.business='Corner Deli' AND grp.name='Fry Option' AND option.name IN ('Nacho Cheese on Side','Gravy on Side')
ON CONFLICT (group_id,name) DO NOTHING;

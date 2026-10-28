-- Points rewards: customers earn points on nearly every order (more per $1 online,
-- double at Monday/Tuesday lunch) and spend them on a reward menu priced by what each
-- reward costs the store. Runs alongside the item-count loyalty programs. Starts
-- switched off; a manager turns it on per business.
CREATE TABLE IF NOT EXISTS ordering_points_settings (
  business TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  online_rate NUMERIC(6,2) NOT NULL DEFAULT 1.1 CHECK (online_rate >= 0),
  store_rate NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (store_rate >= 0),
  staff_phone_orders_earn BOOLEAN NOT NULL DEFAULT TRUE,
  bonus_multiplier NUMERIC(6,2) NOT NULL DEFAULT 2 CHECK (bonus_multiplier >= 1),
  bonus_days INTEGER[] NOT NULL DEFAULT '{1,2}',
  bonus_start TIME NOT NULL DEFAULT '10:30',
  bonus_end TIME NOT NULL DEFAULT '14:00',
  expiry_months INTEGER NOT NULL DEFAULT 12 CHECK (expiry_months >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT ''
);

-- kind: item (one unit of the item's base price), modifier (one regular portion of
-- a matching add-on), upgrade (the price difference from from_variant_id).
CREATE TABLE IF NOT EXISTS ordering_points_rewards (
  id UUID PRIMARY KEY,
  business TEXT NOT NULL,
  reward_key TEXT NOT NULL,
  label TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  kind TEXT NOT NULL CHECK (kind IN ('item','modifier','upgrade')),
  item_ids UUID[] NOT NULL DEFAULT '{}',
  variant_ids UUID[] NOT NULL DEFAULT '{}',
  option_ids UUID[] NOT NULL DEFAULT '{}',
  from_variant_id UUID,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT '',
  UNIQUE (business, reward_key)
);

CREATE TABLE IF NOT EXISTS ordering_points_ledger (
  id UUID PRIMARY KEY,
  business TEXT NOT NULL,
  customer_id UUID NOT NULL REFERENCES ordering_customers(id),
  order_id UUID REFERENCES ordering_orders(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('earn','redeem','reversal','adjustment','expiry')),
  points NUMERIC(10,1) NOT NULL,
  related_event_id UUID REFERENCES ordering_points_ledger(id),
  reason TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ordering_points_ledger_customer_idx ON ordering_points_ledger (customer_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ordering_points_ledger_one_earn ON ordering_points_ledger (order_id) WHERE entry_type = 'earn';
CREATE UNIQUE INDEX IF NOT EXISTS ordering_points_ledger_one_reversal ON ordering_points_ledger (related_event_id) WHERE entry_type = 'reversal';

CREATE TABLE IF NOT EXISTS ordering_order_points_redemptions (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES ordering_customers(id),
  reward_id UUID NOT NULL REFERENCES ordering_points_rewards(id),
  label_snapshot TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  discount_cents INTEGER NOT NULL CHECK (discount_cents >= 0),
  ledger_event_id UUID REFERENCES ordering_points_ledger(id),
  requested_by TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, order_item_id, reward_id)
);
CREATE INDEX IF NOT EXISTS ordering_order_points_redemptions_order_idx ON ordering_order_points_redemptions (order_id);

-- Staff-taken orders spend points only after the customer reads back a code texted
-- to the phone on their account.
CREATE TABLE IF NOT EXISTS ordering_points_redeem_codes (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES ordering_customers(id),
  normalized_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  requested_by TEXT NOT NULL,
  verified_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ordering_points_redeem_codes_order_idx ON ordering_points_redeem_codes (order_id, created_at);
ALTER TABLE ordering_order_points_redemptions ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT '';

INSERT INTO ordering_points_settings (business) VALUES ('Corner Deli') ON CONFLICT (business) DO NOTHING;

-- Corner Deli's reward menu (agreed 2026-10-28). Items are matched by name; a reward
-- whose menu item is missing in this database is skipped.
INSERT INTO ordering_points_rewards (id,business,reward_key,label,points,kind,item_ids,variant_ids,sort_order)
SELECT gen_random_uuid(),'Corner Deli',seed.reward_key,seed.label,seed.points,'item',ARRAY[item.id],
  COALESCE((SELECT ARRAY_AGG(variant.id) FROM ordering_menu_item_variants variant WHERE variant.item_id=item.id AND variant.active AND variant.name=seed.variant_name),'{}'),
  seed.sort_order
FROM (VALUES
  ('small-fries','Free Small French Fries',25,'Small French Fries',NULL,20),
  ('small-tots','Free Small Tater Tots',35,'Small Tater Tots',NULL,30),
  ('fried-dough','Free Fried Bread Dough',35,'Fried Bread Dough',NULL,31),
  ('onion-rings','Free Onion Rings',45,'Onion Rings',NULL,40),
  ('hot-dog','Free Hot Dog',45,'Hot Dog',NULL,41),
  ('cheese-quesadilla','Free Cheese Quesadilla',50,'Cheese Quesadilla',NULL,50),
  ('breaded-mushrooms','Free Breaded Mushrooms',65,'Breaded Mushrooms',NULL,60),
  ('cheeseburger','Free Cheeseburger',75,'Cheeseburger (1/4lbs)',NULL,70),
  ('cheesy-breadsticks','Free Cheesy Breadsticks',95,'Cheesy Breadsticks',NULL,80),
  ('mozzarella-sticks','Free Mozzarella Sticks',100,'Mozzarella Sticks',NULL,90),
  ('small-cheese-pizza','Free Small 12" cheese pizza',100,'Pizza','Small 12"',91),
  ('pizza-logs','Free Pizza Logs',120,'Pizza Logs',NULL,100)
) AS seed(reward_key,label,points,item_name,variant_name,sort_order)
JOIN LATERAL (SELECT id FROM ordering_menu_items WHERE business='Corner Deli' AND active AND name=seed.item_name ORDER BY sort_order,id LIMIT 1) item ON TRUE
WHERE seed.variant_name IS NULL OR EXISTS (SELECT 1 FROM ordering_menu_item_variants variant WHERE variant.item_id=item.id AND variant.active AND variant.name=seed.variant_name)
ON CONFLICT (business,reward_key) DO NOTHING;

INSERT INTO ordering_points_rewards (id,business,reward_key,label,points,kind,option_ids,sort_order)
SELECT gen_random_uuid(),'Corner Deli',seed.reward_key,seed.label,20,'modifier',seed.option_ids,seed.sort_order
FROM (
  SELECT 'pizza-topping' reward_key,'Free pizza topping' label,10 sort_order,
    (SELECT ARRAY_AGG(DISTINCT option.id) FROM ordering_modifier_presentation_overrides presentation
      JOIN ordering_modifier_options option ON option.group_id=presentation.group_id AND option.active
      JOIN ordering_modifier_groups grp ON grp.id=option.group_id AND grp.business='Corner Deli'
      WHERE presentation.behavior='pizza_topping') option_ids
  UNION ALL
  SELECT 'bacon','Free bacon',11,
    (SELECT ARRAY_AGG(option.id) FROM ordering_modifier_options option JOIN ordering_modifier_groups grp ON grp.id=option.group_id
      WHERE grp.business='Corner Deli' AND grp.name='Burger Bacon' AND option.name='Bacon' AND option.active)
  UNION ALL
  SELECT 'extra-cheese','Free extra cheese',12,
    (SELECT ARRAY_AGG(option.id) FROM ordering_modifier_options option JOIN ordering_modifier_groups grp ON grp.id=option.group_id
      WHERE grp.business='Corner Deli' AND option.active AND option.name IN ('Extra Cheese','Extra American','Extra Prov','Extra Swiss'))
  UNION ALL
  SELECT '4oz-dip','Free 4 oz dip',14,
    (SELECT ARRAY_AGG(option.id) FROM ordering_modifier_options option JOIN ordering_modifier_groups grp ON grp.id=option.group_id
      WHERE grp.business='Corner Deli' AND option.active AND option.price_delta_cents=175 AND option.name ILIKE '%4oz%')
) seed
WHERE seed.option_ids IS NOT NULL
ON CONFLICT (business,reward_key) DO NOTHING;

INSERT INTO ordering_points_rewards (id,business,reward_key,label,points,kind,variant_ids,from_variant_id,sort_order)
SELECT gen_random_uuid(),'Corner Deli','thin-to-thick','Free Thin to Thick upgrade',20,'upgrade',ARRAY[thick.id],thin.id,13
FROM ordering_menu_items item
JOIN ordering_menu_item_variants thick ON thick.item_id=item.id AND thick.active AND thick.name='Jumbo Thick 16"'
JOIN ordering_menu_item_variants thin ON thin.item_id=item.id AND thin.active AND thin.name='Jumbo Thin 16"'
WHERE item.business='Corner Deli' AND item.name='Pizza' AND item.active
ON CONFLICT (business,reward_key) DO NOTHING;

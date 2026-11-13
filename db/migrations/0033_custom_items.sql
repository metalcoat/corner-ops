-- Custom items: a line staff type in on the POS with their own name and price. They hang off a hidden
-- "Custom item" menu entry (order lines need a menu item) and skip the menu price and availability checks.
ALTER TABLE ordering_order_items
  ADD COLUMN IF NOT EXISTS custom_item boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS added_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS added_by_name text NOT NULL DEFAULT '';

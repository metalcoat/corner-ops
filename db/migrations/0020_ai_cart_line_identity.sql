-- Logical line identity survives draft repricing (physical rows are replaced atomically).
ALTER TABLE ordering_order_items ADD COLUMN cart_line_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX ordering_order_items_cart_line_idx ON ordering_order_items(order_id, cart_line_id);

-- Scheduled (future) orders are held from the kitchen ticket printer, the kitchen
-- screen and the online-order chime until prep time before they're due
-- (src/lib/ordering-kitchen-release.ts). NULL = release right away. The column was
-- reserved in 0014 and unused until now; this makes sure it exists and indexes it.
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS kitchen_release_at timestamptz;
CREATE INDEX IF NOT EXISTS ordering_orders_kitchen_release_idx
  ON ordering_orders (business, kitchen_release_at)
  WHERE kitchen_release_at IS NOT NULL;

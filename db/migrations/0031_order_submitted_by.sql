-- Who sent an order to the kitchen (employee id, or web:/openai:/gemini: for online and AI phone orders).
-- Not recorded before 2026-10-30; shown on the POS Orders cards next to who took the order.
ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS submitted_by text NOT NULL DEFAULT '';

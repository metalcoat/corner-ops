-- The MX Merchant customer each Corner Ops customer's saved cards live under
-- (src/lib/mx-saved-cards.ts). Saved cards themselves are in
-- ordering_customer_payment_methods (MX's vault token, brand, last 4 only).
ALTER TABLE ordering_customers ADD COLUMN IF NOT EXISTS mx_customer_id text NOT NULL DEFAULT '';

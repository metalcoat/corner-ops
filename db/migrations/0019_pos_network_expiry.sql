-- Approved POS networks (outside the store) expire 90 days after approval and must be
-- approved again by the owner. Existing approvals get 90 days from their approval date
-- (at least 14 days from now, so nobody is cut off the day this ships).
ALTER TABLE pos_network_allowlist ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE pos_network_allowlist SET expires_at = GREATEST(approved_at + INTERVAL '90 days', NOW() + INTERVAL '14 days') WHERE expires_at IS NULL;

-- Entrance door chime: one row per customer walk-in reported by the camera detector,
-- and when staff greeted them (time to greet on the store dashboard).
CREATE TABLE IF NOT EXISTS door_chime_events (
  id BIGSERIAL PRIMARY KEY,
  business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  camera TEXT NOT NULL DEFAULT 'entrance',
  kind TEXT NOT NULL DEFAULT 'person',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  greeted_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('greeted', 'not_customer')),
  greeted_by_employee_id TEXT,
  greeted_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_door_chime_events_recent
ON door_chime_events (business, detected_at DESC);

ALTER TABLE schedule_publications
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'Completed',
  ADD COLUMN IF NOT EXISTS delivery_completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS schedule_publications_idempotency_idx
  ON schedule_publications (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE three_cx_cdr_records
  ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ
  GENERATED ALWAYS AS (COALESCE(ended_at, started_at, received_at)) STORED;

CREATE INDEX IF NOT EXISTS three_cx_cdr_event_at_idx
  ON three_cx_cdr_records (event_at);

DROP TRIGGER IF EXISTS corner_ops_schedule_message_type ON employee_messages;
DROP FUNCTION IF EXISTS corner_ops_normalize_employee_message_type();

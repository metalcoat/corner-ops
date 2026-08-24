-- Stage 6: durable, retryable external schedule delivery.
CREATE TABLE IF NOT EXISTS schedule_publication_deliveries (
  id UUID PRIMARY KEY,
  publication_id UUID NOT NULL REFERENCES schedule_publications(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('Email')),
  destination TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Sending', 'Sent', 'Failed', 'Waiting Configuration')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (publication_id, employee_id, channel)
);

CREATE INDEX IF NOT EXISTS schedule_publication_delivery_pending_idx
  ON schedule_publication_deliveries (status, next_attempt_at, created_at)
  WHERE status <> 'Sent';

-- CO-074: share the Corner Deli wallboard 3CX report cache across serverless instances.
CREATE TABLE IF NOT EXISTS deli_board_call_cache (
  work_date DATE PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deli_board_call_cache_expires_idx
  ON deli_board_call_cache (expires_at);

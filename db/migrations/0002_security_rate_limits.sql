CREATE TABLE IF NOT EXISTS security_rate_limits (
  scope TEXT NOT NULL,
  discriminator_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, discriminator_hash)
);

CREATE INDEX IF NOT EXISTS security_rate_limits_blocked_idx
  ON security_rate_limits (blocked_until)
  WHERE blocked_until IS NOT NULL;

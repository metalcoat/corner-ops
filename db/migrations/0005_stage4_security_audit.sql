CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS pin_salt TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pin_hash_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS pin_fingerprint TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sms_consent_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS employees_business_pin_fingerprint_unique
  ON employees (business, pin_fingerprint)
  WHERE pin_fingerprint <> '';

ALTER TABLE employee_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS delete_reason TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS employee_messages_business_created_idx;
CREATE INDEX IF NOT EXISTS employee_messages_business_created_idx
  ON employee_messages (business, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_action_check;
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'document',
  ADD COLUMN IF NOT EXISTS entity_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events (business, entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_consent_events (
  id UUID PRIMARY KEY,
  business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('Opt In', 'Opt Out', 'Help')),
  keyword TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sms_consent_events_phone_idx
  ON sms_consent_events (phone, created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_state_nonces (
  nonce_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS oauth_state_nonces_active_idx
  ON oauth_state_nonces (purpose, expires_at)
  WHERE used_at IS NULL;

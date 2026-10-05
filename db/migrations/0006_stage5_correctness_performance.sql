-- Stage 5: residual correctness/performance fixes from CODEBASEREVIEW.

-- CO-063: range queries on Rezku order timestamps must not scan the full table.
CREATE INDEX IF NOT EXISTS rezku_orders_opened_idx ON rezku_orders (opened_at);

-- CO-064: an acknowledgment belongs to the actual handbook content, not only a hand-maintained version label.
CREATE TABLE IF NOT EXISTS employee_handbook_acknowledgments (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id),
  employee_name TEXT NOT NULL,
  business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  handbook_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  signature_name TEXT NOT NULL,
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE employee_handbook_acknowledgments
  DROP CONSTRAINT IF EXISTS employee_handbook_acknowledgments_employee_id_handbook_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS employee_handbook_ack_employee_hash_unique
  ON employee_handbook_acknowledgments (employee_id, handbook_version, content_hash);
CREATE INDEX IF NOT EXISTS employee_handbook_ack_business_idx
  ON employee_handbook_acknowledgments (business, handbook_version, content_hash, acknowledged_at DESC);

-- CO-054: 3CX's delimiter CDR exports naive timestamps that are UTC wall-clock values.
-- Earlier ingestion interpreted those strings as America/New_York before storing TIMESTAMPTZ,
-- shifting the stored instant by 4/5 hours. Rebuild each stored timestamp directly from the
-- original raw UTC text. This is idempotent and safe to repeat after the app deploy to catch
-- any records ingested during the deployment window.
UPDATE three_cx_cdr_records
SET
  started_at = CASE
    WHEN COALESCE(raw->>'time-start', '') ~ '^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}$'
      THEN (REPLACE(raw->>'time-start', '/', '-') || ' UTC')::timestamptz
    ELSE started_at
  END,
  answered_at = CASE
    WHEN COALESCE(raw->>'time-answered', '') ~ '^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}$'
      THEN (REPLACE(raw->>'time-answered', '/', '-') || ' UTC')::timestamptz
    ELSE answered_at
  END,
  ended_at = CASE
    WHEN COALESCE(raw->>'time-end', '') ~ '^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}$'
      THEN (REPLACE(raw->>'time-end', '/', '-') || ' UTC')::timestamptz
    ELSE ended_at
  END
WHERE
  COALESCE(raw->>'time-start', '') <> ''
  OR COALESCE(raw->>'time-answered', '') <> ''
  OR COALESCE(raw->>'time-end', '') <> '';

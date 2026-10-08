CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY,
  business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  document_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Active', 'Needs Review', 'Archived')),
  notes TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  blob_url TEXT NOT NULL UNIQUE,
  blob_pathname TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_business_created_idx ON documents (business, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  document_id UUID,
  action TEXT NOT NULL CHECK (action IN ('uploaded', 'updated', 'archived', 'restored', 'deleted')),
  actor TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_business_created_idx ON audit_events (business, created_at DESC);

-- Scanner identifiers resolve to stable catalog UUIDs. Historical mappings are
-- deactivated, never deleted, and active duplicates are rejected per business.
CREATE TABLE IF NOT EXISTS ordering_barcode_mappings (
  id UUID PRIMARY KEY,
  business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  barcode TEXT NOT NULL,
  barcode_format TEXT NOT NULL CHECK (barcode_format IN ('upc_a','ean_8','ean_13','gtin_14','code_128_text')),
  item_id UUID NOT NULL REFERENCES ordering_menu_items(id),
  variant_id UUID REFERENCES ordering_menu_item_variants(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ordering_barcode_one_active_idx ON ordering_barcode_mappings (business, barcode) WHERE active=TRUE;
CREATE INDEX IF NOT EXISTS ordering_barcode_target_idx ON ordering_barcode_mappings (business,item_id,variant_id,active);
CREATE TABLE IF NOT EXISTS ordering_barcode_audit (
  id UUID PRIMARY KEY,
  mapping_id UUID NOT NULL REFERENCES ordering_barcode_mappings(id),
  business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
  action TEXT NOT NULL CHECK (action IN ('created','updated','activated','deactivated')),
  barcode TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ordering_barcode_audit_mapping_idx ON ordering_barcode_audit(mapping_id,created_at DESC);

-- Copies of the documents an employee chose for Form I-9 (List A, or List B + List C). Uploaded by the
-- employee after Section 1; the file itself is AES-256-GCM encrypted with the forms key before it is stored.
-- The manager still examines the originals in person for Section 2; copies are kept with the I-9.
CREATE TABLE IF NOT EXISTS employment_form_documents (
  id uuid PRIMARY KEY,
  business text NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  form_id uuid NOT NULL REFERENCES employment_forms(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  document_list text NOT NULL CHECK (document_list IN ('A', 'B', 'C')),
  document_title text NOT NULL,
  file_name text NOT NULL DEFAULT '',
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  storage_pathname text NOT NULL,
  storage_url text NOT NULL,
  encryption_iv text NOT NULL,
  encryption_tag text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS employment_form_documents_form_idx ON employment_form_documents (form_id) WHERE deleted_at IS NULL;

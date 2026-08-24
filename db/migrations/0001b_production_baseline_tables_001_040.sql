-- Baseline tables 1-40 of 117. Generated from validated production catalog.

CREATE TABLE public.accounting_accounts (
  id uuid NOT NULL,
  business text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL,
  active boolean DEFAULT true NOT NULL
);

CREATE TABLE public.app_users (
  id uuid NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  businesses text[] DEFAULT ARRAY['Corner Deli'::text, 'Tiki'::text] NOT NULL,
  password_salt text DEFAULT ''::text NOT NULL,
  password_hash text DEFAULT ''::text NOT NULL,
  legacy_owner boolean DEFAULT false NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  session_version integer DEFAULT 1 NOT NULL
);

CREATE TABLE public.application_key_material (
  purpose text NOT NULL,
  encrypted_private_value text NOT NULL,
  public_value text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.audit_events (
  id uuid NOT NULL,
  business text NOT NULL,
  document_id uuid,
  action text NOT NULL,
  actor text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  entity_type text DEFAULT 'document'::text NOT NULL,
  entity_id text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.bank_accounts (
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  business text NOT NULL,
  external_account_id text NOT NULL,
  institution_name text NOT NULL,
  name text NOT NULL,
  official_name text DEFAULT ''::text NOT NULL,
  mask text DEFAULT ''::text NOT NULL,
  account_type text DEFAULT ''::text NOT NULL,
  account_subtype text DEFAULT ''::text NOT NULL,
  current_balance numeric(14,2),
  available_balance numeric(14,2),
  currency text DEFAULT 'USD'::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.bank_reconciliation_items (
  reconciliation_id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.bank_reconciliations (
  id uuid NOT NULL,
  business text NOT NULL,
  external_account_id text NOT NULL,
  statement_start_date date NOT NULL,
  statement_end_date date NOT NULL,
  statement_beginning_balance numeric(14,2) NOT NULL,
  statement_ending_balance numeric(14,2) NOT NULL,
  cleared_activity numeric(14,2) DEFAULT 0 NOT NULL,
  difference numeric(14,2) DEFAULT 0 NOT NULL,
  status text DEFAULT 'Draft'::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  created_by text NOT NULL,
  finalized_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  finalized_at timestamp with time zone
);

CREATE TABLE public.bank_transaction_postings (
  id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  journal_entry_id uuid NOT NULL,
  posted_by text NOT NULL,
  posted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.bank_transaction_splits (
  id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  line_number integer NOT NULL,
  account_code text NOT NULL,
  amount numeric(14,2) NOT NULL,
  memo text DEFAULT ''::text NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  invoice_id uuid
);

CREATE TABLE public.bank_transactions (
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  business text NOT NULL,
  external_transaction_id text NOT NULL,
  external_account_id text DEFAULT ''::text NOT NULL,
  transaction_date date NOT NULL,
  authorized_date date,
  merchant_name text DEFAULT ''::text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  signed_amount numeric(14,2) NOT NULL,
  direction text NOT NULL,
  pending boolean DEFAULT false NOT NULL,
  removed boolean DEFAULT false NOT NULL,
  plaid_primary text DEFAULT ''::text NOT NULL,
  plaid_detail text DEFAULT ''::text NOT NULL,
  category text DEFAULT ''::text NOT NULL,
  account_code text DEFAULT ''::text NOT NULL,
  classification_source text DEFAULT ''::text NOT NULL,
  confidence numeric(5,4) DEFAULT 0 NOT NULL,
  review_status text DEFAULT 'Needs Review'::text NOT NULL,
  user_override boolean DEFAULT false NOT NULL,
  payment_channel text DEFAULT ''::text NOT NULL,
  check_number text DEFAULT ''::text NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.classification_rules (
  id uuid NOT NULL,
  business text NOT NULL,
  priority integer DEFAULT 100 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  direction text DEFAULT 'Any'::text NOT NULL,
  field text DEFAULT 'Either'::text NOT NULL,
  match_type text DEFAULT 'Contains'::text NOT NULL,
  pattern text NOT NULL,
  category text NOT NULL,
  account_code text NOT NULL,
  confidence numeric(5,4) DEFAULT 1 NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.credential_reset_tokens (
  id uuid NOT NULL,
  kind text NOT NULL,
  subject_id uuid NOT NULL,
  business text,
  email text NOT NULL,
  token_hash text NOT NULL,
  requested_ip text DEFAULT ''::text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.credit_card_statement_transactions (
  id uuid NOT NULL,
  statement_id uuid NOT NULL,
  transaction_date date NOT NULL,
  description text NOT NULL,
  amount numeric(14,2) NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.credit_card_statements (
  id uuid NOT NULL,
  business text NOT NULL,
  issuer text NOT NULL,
  account_name text DEFAULT ''::text NOT NULL,
  last_four text DEFAULT ''::text NOT NULL,
  statement_end_date date NOT NULL,
  statement_balance numeric(14,2) DEFAULT 0 NOT NULL,
  payment_amount numeric(14,2) DEFAULT 0 NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  blob_url text NOT NULL,
  blob_pathname text NOT NULL,
  extraction_status text NOT NULL,
  parsed_transaction_count integer DEFAULT 0 NOT NULL,
  parsed_total numeric(14,2) DEFAULT 0 NOT NULL,
  suggested_bank_transaction_id uuid,
  matched_bank_transaction_id uuid,
  match_status text DEFAULT 'Unmatched'::text NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.credit_card_transfer_matches (
  id uuid NOT NULL,
  business text NOT NULL,
  bank_transaction_id uuid NOT NULL,
  card_transaction_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  date_difference integer DEFAULT 0 NOT NULL,
  confidence numeric(5,4) DEFAULT 0 NOT NULL,
  status text DEFAULT 'Suggested'::text NOT NULL,
  matched_by text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  matched_at timestamp with time zone
);

CREATE TABLE public.deli_wallboard_task_checks (
  task_id uuid NOT NULL,
  work_date date NOT NULL,
  completed boolean DEFAULT true NOT NULL,
  completed_by text DEFAULT ''::text NOT NULL,
  completed_at timestamp with time zone
);

CREATE TABLE public.deli_wallboard_tasks (
  id uuid NOT NULL,
  title text NOT NULL,
  category text DEFAULT 'Daily'::text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_by text DEFAULT 'System'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.direct_deposit_elections (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid NOT NULL,
  employee_name text NOT NULL,
  status text NOT NULL,
  encrypted_payload text NOT NULL,
  assigned_by text NOT NULL,
  assigned_at timestamp with time zone DEFAULT now() NOT NULL,
  employee_signature_name text DEFAULT ''::text NOT NULL,
  signed_at timestamp with time zone,
  signature_ip text DEFAULT ''::text NOT NULL,
  signature_user_agent text DEFAULT ''::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  rescinded_by text,
  rescinded_at timestamp with time zone,
  rescind_reason text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.documents (
  id uuid NOT NULL,
  business text NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  document_date date NOT NULL,
  status text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  blob_url text NOT NULL,
  blob_pathname text NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.employee_availability (
  id uuid NOT NULL,
  employee_id uuid NOT NULL,
  business text NOT NULL,
  weekday integer NOT NULL,
  available boolean DEFAULT true NOT NULL,
  available_from text DEFAULT ''::text NOT NULL,
  available_to text DEFAULT ''::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.employee_handbook_acknowledgments (
  id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employee_name text NOT NULL,
  business text NOT NULL,
  handbook_version text NOT NULL,
  content_hash text NOT NULL,
  signature_name text NOT NULL,
  ip_address text DEFAULT ''::text NOT NULL,
  user_agent text DEFAULT ''::text NOT NULL,
  acknowledged_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.employee_message_reads (
  message_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  read_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.employee_messages (
  id uuid NOT NULL,
  business text NOT NULL,
  sender_employee_id uuid,
  sender_name text NOT NULL,
  recipient_employee_id uuid,
  message_type text DEFAULT 'Team'::text NOT NULL,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  attachment_url text DEFAULT ''::text NOT NULL,
  attachment_pathname text DEFAULT ''::text NOT NULL,
  attachment_name text DEFAULT ''::text NOT NULL,
  attachment_type text DEFAULT ''::text NOT NULL,
  attachment_size bigint DEFAULT 0 NOT NULL,
  deleted_at timestamp with time zone,
  deleted_by text DEFAULT ''::text NOT NULL,
  delete_reason text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.employees (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  pin_hash text NOT NULL,
  "position" text DEFAULT 'Bartender'::text NOT NULL,
  role_group text DEFAULT 'In-House'::text NOT NULL,
  counts_for_tips boolean DEFAULT true NOT NULL,
  hourly_rate numeric(10,2) DEFAULT 0 NOT NULL,
  tipped_rate numeric(10,2) DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  email text DEFAULT ''::text NOT NULL,
  phone text DEFAULT ''::text NOT NULL,
  sms_opt_in boolean DEFAULT false NOT NULL,
  pin_enabled boolean DEFAULT true NOT NULL,
  schedule_color text DEFAULT ''::text NOT NULL,
  profile_photo_url text DEFAULT ''::text NOT NULL,
  profile_photo_pathname text DEFAULT ''::text NOT NULL,
  profile_photo_name text DEFAULT ''::text NOT NULL,
  profile_photo_type text DEFAULT ''::text NOT NULL,
  profile_photo_size bigint DEFAULT 0 NOT NULL,
  chat_nickname text DEFAULT ''::text NOT NULL,
  pin_salt text DEFAULT ''::text NOT NULL,
  pin_hash_version integer DEFAULT 1 NOT NULL,
  pin_fingerprint text DEFAULT ''::text NOT NULL,
  session_version integer DEFAULT 1 NOT NULL,
  sms_consent_updated_at timestamp with time zone,
  sms_opted_out_at timestamp with time zone
);

CREATE TABLE public.employment_form_events (
  id uuid NOT NULL,
  form_id uuid NOT NULL,
  action text NOT NULL,
  actor text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.employment_form_profiles (
  business text NOT NULL,
  profile jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_by text DEFAULT ''::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.employment_forms (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid NOT NULL,
  employee_name text NOT NULL,
  form_type text NOT NULL,
  title text NOT NULL,
  template_version text NOT NULL,
  source_url text NOT NULL,
  status text NOT NULL,
  effective_date date,
  encrypted_payload text NOT NULL,
  assigned_by text NOT NULL,
  assigned_at timestamp with time zone DEFAULT now() NOT NULL,
  employee_signature_name text DEFAULT ''::text NOT NULL,
  employee_signed_at timestamp with time zone,
  employer_signature_name text DEFAULT ''::text NOT NULL,
  employer_signed_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.forecast_events (
  id uuid NOT NULL,
  business text NOT NULL,
  event_date date NOT NULL,
  description text NOT NULL,
  amount numeric(14,2) NOT NULL,
  direction text NOT NULL,
  recurrence text DEFAULT 'None'::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.integration_connections (
  id uuid NOT NULL,
  provider text NOT NULL,
  business text NOT NULL,
  institution_name text NOT NULL,
  external_item_id text NOT NULL,
  encrypted_access_token text DEFAULT ''::text NOT NULL,
  encrypted_refresh_token text DEFAULT ''::text NOT NULL,
  token_expires_at timestamp with time zone,
  cursor text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'Active'::text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  last_sync_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.integration_sync_runs (
  id uuid NOT NULL,
  connection_id uuid,
  provider text NOT NULL,
  business text NOT NULL,
  status text NOT NULL,
  records_added integer DEFAULT 0 NOT NULL,
  records_modified integer DEFAULT 0 NOT NULL,
  records_removed integer DEFAULT 0 NOT NULL,
  message text DEFAULT ''::text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone
);

CREATE TABLE public.inventory_items (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  category text DEFAULT ''::text NOT NULL,
  base_unit text DEFAULT 'each'::text NOT NULL,
  par_quantity numeric(14,4) DEFAULT 0 NOT NULL,
  current_quantity numeric(14,4) DEFAULT 0 NOT NULL,
  reorder_point numeric(14,4) DEFAULT 0 NOT NULL,
  preferred_vendor text DEFAULT ''::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.inventory_purchases (
  id uuid NOT NULL,
  business text NOT NULL,
  inventory_item_id uuid NOT NULL,
  vendor text NOT NULL,
  purchase_date date NOT NULL,
  quantity numeric(14,4) NOT NULL,
  unit text NOT NULL,
  unit_price numeric(14,4) NOT NULL,
  total_amount numeric(14,2) NOT NULL,
  bill_id uuid,
  source text DEFAULT 'Manual'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.invoice_payment_allocations (
  id uuid NOT NULL,
  business text NOT NULL,
  invoice_id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.invoices (
  id uuid NOT NULL,
  business text NOT NULL,
  template_id uuid NOT NULL,
  invoice_number text NOT NULL,
  customer_name text NOT NULL,
  invoice_date date NOT NULL,
  due_date date NOT NULL,
  period_key text NOT NULL,
  period_label text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  amount numeric(14,2) NOT NULL,
  amount_paid numeric(14,2) DEFAULT 0 NOT NULL,
  balance numeric(14,2) NOT NULL,
  status text DEFAULT 'Open'::text NOT NULL,
  revenue_account_code text NOT NULL,
  journal_entry_id uuid,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.journal_entries (
  id uuid NOT NULL,
  business text NOT NULL,
  entry_date date NOT NULL,
  description text NOT NULL,
  source text DEFAULT 'Manual'::text NOT NULL,
  reference text DEFAULT ''::text NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.journal_lines (
  id uuid NOT NULL,
  entry_id uuid NOT NULL,
  account_id uuid NOT NULL,
  debit numeric(14,2) DEFAULT 0 NOT NULL,
  credit numeric(14,2) DEFAULT 0 NOT NULL
);

CREATE TABLE public.manual_time_entry_audit (
  id uuid NOT NULL,
  business text NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employee_name text NOT NULL,
  action text DEFAULT 'Manager Added'::text NOT NULL,
  actor text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.missed_shift_cases (
  id uuid NOT NULL,
  shift_id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid NOT NULL,
  employee_name text NOT NULL,
  employee_email text DEFAULT ''::text NOT NULL,
  "position" text DEFAULT ''::text NOT NULL,
  scheduled_start timestamp with time zone NOT NULL,
  scheduled_end timestamp with time zone NOT NULL,
  correction_start timestamp with time zone,
  correction_end timestamp with time zone,
  employee_note text DEFAULT ''::text NOT NULL,
  submission_channel text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'Awaiting Correction'::text NOT NULL,
  notified_at timestamp with time zone,
  notification_error text DEFAULT ''::text NOT NULL,
  detected_at timestamp with time zone DEFAULT now() NOT NULL,
  reviewed_by text DEFAULT ''::text NOT NULL,
  reviewed_at timestamp with time zone,
  manager_note text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.oauth_state_nonces (
  nonce_hash text NOT NULL,
  purpose text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.operation_issues (
  id uuid NOT NULL,
  issue_key text NOT NULL,
  business text NOT NULL,
  issue_type text NOT NULL,
  severity text DEFAULT 'Warning'::text NOT NULL,
  title text NOT NULL,
  details text DEFAULT ''::text NOT NULL,
  reference text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'Open'::text NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone
);

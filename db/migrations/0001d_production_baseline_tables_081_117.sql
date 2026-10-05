-- Baseline tables 81-117 of 117. Generated from validated production catalog.

CREATE TABLE public.rezku_import_batches (
  id uuid NOT NULL,
  business text DEFAULT 'Corner Deli'::text NOT NULL,
  report_type text NOT NULL,
  file_name text NOT NULL,
  row_count integer DEFAULT 0 NOT NULL,
  imported_by text NOT NULL,
  imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.rezku_inbound_emails (
  email_id text NOT NULL,
  webhook_id text DEFAULT ''::text NOT NULL,
  sender text DEFAULT ''::text NOT NULL,
  subject text DEFAULT ''::text NOT NULL,
  report_date date,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  status text DEFAULT 'Received'::text NOT NULL,
  reports_found integer DEFAULT 0 NOT NULL,
  reports_processed integer DEFAULT 0 NOT NULL,
  error_text text DEFAULT ''::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.rezku_inbound_reports (
  id uuid NOT NULL,
  email_id text NOT NULL,
  file_name text NOT NULL,
  report_type text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'Processing'::text NOT NULL,
  batch_id uuid,
  rows_read integer DEFAULT 0 NOT NULL,
  rows_imported integer DEFAULT 0 NOT NULL,
  error_text text DEFAULT ''::text NOT NULL,
  processed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.rezku_orders (
  id uuid NOT NULL,
  source_key text NOT NULL,
  batch_id uuid NOT NULL,
  order_id text NOT NULL,
  opened_at timestamp with time zone,
  order_type text DEFAULT ''::text NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public.rezku_product_sales (
  id uuid NOT NULL,
  source_key text NOT NULL,
  batch_id uuid NOT NULL,
  business_date date NOT NULL,
  category text DEFAULT ''::text NOT NULL,
  product text NOT NULL,
  list_price numeric(14,4) DEFAULT 0 NOT NULL,
  average_price numeric(14,4) DEFAULT 0 NOT NULL,
  quantity numeric(14,3) DEFAULT 0 NOT NULL,
  sales numeric(14,2) DEFAULT 0 NOT NULL,
  percent_sales numeric(14,8) DEFAULT 0 NOT NULL,
  average_profit numeric(14,4) DEFAULT 0 NOT NULL,
  profit numeric(14,2) DEFAULT 0 NOT NULL,
  percent_profit numeric(14,8) DEFAULT 0 NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.rezku_product_sales_import_batches (
  id uuid NOT NULL,
  business text DEFAULT 'Corner Deli'::text NOT NULL,
  report_type text DEFAULT 'sales_by_product'::text NOT NULL,
  business_date date NOT NULL,
  file_name text NOT NULL,
  row_count integer DEFAULT 0 NOT NULL,
  imported_by text NOT NULL,
  imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.rezku_shifts (
  id uuid NOT NULL,
  source_key text NOT NULL,
  batch_id uuid NOT NULL,
  employee_name text NOT NULL,
  "position" text DEFAULT ''::text NOT NULL,
  role_group text DEFAULT 'In-House'::text NOT NULL,
  clock_in timestamp with time zone,
  clock_out timestamp with time zone,
  reported_hours numeric(10,4) DEFAULT 0 NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public.rezku_transactions (
  id uuid NOT NULL,
  source_key text NOT NULL,
  batch_id uuid NOT NULL,
  transaction_id text DEFAULT ''::text NOT NULL,
  order_id text DEFAULT ''::text NOT NULL,
  transaction_time timestamp with time zone,
  tip numeric(12,2) DEFAULT 0 NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public.rezku_void_events (
  id uuid NOT NULL,
  source_key text NOT NULL,
  batch_id uuid NOT NULL,
  void_type text NOT NULL,
  order_id text DEFAULT ''::text NOT NULL,
  transaction_id text DEFAULT ''::text NOT NULL,
  voided_at timestamp with time zone,
  employee_name text DEFAULT ''::text NOT NULL,
  voided_by text DEFAULT ''::text NOT NULL,
  reason text DEFAULT ''::text NOT NULL,
  item_name text DEFAULT ''::text NOT NULL,
  quantity numeric(12,3) DEFAULT 0 NOT NULL,
  amount numeric(14,2) DEFAULT 0 NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public.rezku_void_import_batches (
  id uuid NOT NULL,
  business text DEFAULT 'Corner Deli'::text NOT NULL,
  report_type text NOT NULL,
  file_name text NOT NULL,
  row_count integer DEFAULT 0 NOT NULL,
  imported_by text NOT NULL,
  imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.schedule_publication_deliveries (
  id uuid NOT NULL,
  publication_id uuid NOT NULL,
  employee_id uuid,
  channel text NOT NULL,
  destination text DEFAULT ''::text NOT NULL,
  subject text DEFAULT ''::text NOT NULL,
  body text DEFAULT ''::text NOT NULL,
  idempotency_key text NOT NULL,
  status text DEFAULT 'Pending'::text NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  provider_id text DEFAULT ''::text NOT NULL,
  last_error text DEFAULT ''::text NOT NULL,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  sent_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.schedule_publications (
  id uuid NOT NULL,
  business text NOT NULL,
  week_start date NOT NULL,
  week_end date NOT NULL,
  published_by text NOT NULL,
  shift_count integer DEFAULT 0 NOT NULL,
  active_employee_count integer DEFAULT 0 NOT NULL,
  email_sent_count integer DEFAULT 0 NOT NULL,
  email_missing_count integer DEFAULT 0 NOT NULL,
  email_failed_count integer DEFAULT 0 NOT NULL,
  email_configured boolean DEFAULT false NOT NULL,
  sms_sent_count integer DEFAULT 0 NOT NULL,
  sms_missing_count integer DEFAULT 0 NOT NULL,
  sms_failed_count integer DEFAULT 0 NOT NULL,
  sms_configured boolean DEFAULT false NOT NULL,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  published_at timestamp with time zone DEFAULT now() NOT NULL,
  idempotency_key text,
  delivery_status text DEFAULT 'Completed'::text NOT NULL,
  delivery_completed_at timestamp with time zone
);

CREATE TABLE public.schedule_shifts (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid,
  "position" text DEFAULT ''::text NOT NULL,
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone NOT NULL,
  status text DEFAULT 'Draft'::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  created_by text NOT NULL,
  published_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  meal_break_start timestamp with time zone,
  meal_break_minutes integer DEFAULT 0 NOT NULL,
  extra_meal_break_start timestamp with time zone,
  extra_meal_break_minutes integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.scheduler_runs (
  id uuid NOT NULL,
  run_key text NOT NULL,
  local_date date NOT NULL,
  local_hour integer NOT NULL,
  status text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone
);

CREATE TABLE public.schema_migrations (
  migration_name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.security_rate_limits (
  scope text NOT NULL,
  discriminator_hash text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  window_started_at timestamp with time zone DEFAULT now() NOT NULL,
  blocked_until timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.shift_change_log (
  id uuid NOT NULL,
  business text NOT NULL,
  shift_id uuid,
  change_type text NOT NULL,
  prior_employee_id uuid,
  prior_employee_name text DEFAULT ''::text NOT NULL,
  new_employee_id uuid,
  new_employee_name text DEFAULT ''::text NOT NULL,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.shift_requests (
  id uuid NOT NULL,
  business text NOT NULL,
  request_type text NOT NULL,
  shift_id uuid NOT NULL,
  offered_shift_id uuid,
  requester_employee_id uuid NOT NULL,
  target_employee_id uuid,
  employee_response text DEFAULT 'Pending'::text NOT NULL,
  status text DEFAULT 'Pending'::text NOT NULL,
  note text DEFAULT ''::text NOT NULL,
  manager_note text DEFAULT ''::text NOT NULL,
  reviewed_by text DEFAULT ''::text NOT NULL,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.sms_consent_events (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid,
  phone text NOT NULL,
  event_type text NOT NULL,
  keyword text DEFAULT ''::text NOT NULL,
  provider_message_id text DEFAULT ''::text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.square_catalog_objects (
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_object_id text NOT NULL,
  object_type text NOT NULL,
  name text DEFAULT ''::text NOT NULL,
  parent_catalog_id text DEFAULT ''::text NOT NULL,
  variation_of_id text DEFAULT ''::text NOT NULL,
  sku text DEFAULT ''::text NOT NULL,
  price numeric(14,2) DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  updated_at_square timestamp with time zone,
  version bigint,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.square_deposit_match_payments (
  match_id uuid NOT NULL,
  square_payment_id uuid NOT NULL
);

CREATE TABLE public.square_deposit_matches (
  id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  business text DEFAULT 'Tiki'::text NOT NULL,
  square_gross numeric(14,2) DEFAULT 0 NOT NULL,
  square_fees numeric(14,2) DEFAULT 0 NOT NULL,
  square_net numeric(14,2) DEFAULT 0 NOT NULL,
  bank_amount numeric(14,2) DEFAULT 0 NOT NULL,
  variance numeric(14,2) DEFAULT 0 NOT NULL,
  status text DEFAULT 'Suggested'::text NOT NULL,
  matched_by text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  matched_at timestamp with time zone
);

CREATE TABLE public.square_inventory_counts (
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  catalog_object_id text NOT NULL,
  location_id text NOT NULL,
  state text DEFAULT 'IN_STOCK'::text NOT NULL,
  quantity numeric(14,4) DEFAULT 0 NOT NULL,
  calculated_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.square_order_lines (
  id uuid NOT NULL,
  square_order_id uuid NOT NULL,
  external_line_id text NOT NULL,
  catalog_object_id text DEFAULT ''::text NOT NULL,
  item_name text DEFAULT ''::text NOT NULL,
  variation_name text DEFAULT ''::text NOT NULL,
  quantity numeric(14,4) DEFAULT 0 NOT NULL,
  gross_sales numeric(14,2) DEFAULT 0 NOT NULL,
  total_tax numeric(14,2) DEFAULT 0 NOT NULL,
  total_discount numeric(14,2) DEFAULT 0 NOT NULL,
  total_money numeric(14,2) DEFAULT 0 NOT NULL,
  modifiers jsonb DEFAULT '[]'::jsonb NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public.square_orders (
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_order_id text NOT NULL,
  location_id text DEFAULT ''::text NOT NULL,
  state text DEFAULT ''::text NOT NULL,
  source_name text DEFAULT ''::text NOT NULL,
  created_at_square timestamp with time zone,
  updated_at_square timestamp with time zone,
  closed_at_square timestamp with time zone,
  total_amount numeric(14,2) DEFAULT 0 NOT NULL,
  tax_total numeric(14,2) DEFAULT 0 NOT NULL,
  tip_total numeric(14,2) DEFAULT 0 NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.square_payments (
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_payment_id text NOT NULL,
  business text DEFAULT 'Tiki'::text NOT NULL,
  order_id text DEFAULT ''::text NOT NULL,
  location_id text DEFAULT ''::text NOT NULL,
  created_at_square timestamp with time zone NOT NULL,
  updated_at_square timestamp with time zone,
  amount numeric(14,2) DEFAULT 0 NOT NULL,
  tip_amount numeric(14,2) DEFAULT 0 NOT NULL,
  status text DEFAULT ''::text NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.square_webhook_events (
  id uuid NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  merchant_id text DEFAULT ''::text NOT NULL,
  location_id text DEFAULT ''::text NOT NULL,
  payload jsonb NOT NULL,
  status text DEFAULT 'Received'::text NOT NULL,
  error text DEFAULT ''::text NOT NULL,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  processed_at timestamp with time zone
);

CREATE TABLE public.three_cx_cdr_records (
  id uuid NOT NULL,
  record_key text NOT NULL,
  history_id text DEFAULT ''::text NOT NULL,
  call_id text DEFAULT ''::text NOT NULL,
  duration_seconds numeric(14,3) DEFAULT 0 NOT NULL,
  started_at timestamp with time zone,
  answered_at timestamp with time zone,
  ended_at timestamp with time zone,
  termination_reason text DEFAULT ''::text NOT NULL,
  from_no text DEFAULT ''::text NOT NULL,
  to_no text DEFAULT ''::text NOT NULL,
  from_dn text DEFAULT ''::text NOT NULL,
  to_dn text DEFAULT ''::text NOT NULL,
  dial_no text DEFAULT ''::text NOT NULL,
  reason_changed text DEFAULT ''::text NOT NULL,
  final_number text DEFAULT ''::text NOT NULL,
  final_dn text DEFAULT ''::text NOT NULL,
  chain text DEFAULT ''::text NOT NULL,
  from_type text DEFAULT ''::text NOT NULL,
  to_type text DEFAULT ''::text NOT NULL,
  final_type text DEFAULT ''::text NOT NULL,
  from_display_name text DEFAULT ''::text NOT NULL,
  to_display_name text DEFAULT ''::text NOT NULL,
  final_display_name text DEFAULT ''::text NOT NULL,
  missed_queue_calls text DEFAULT ''::text NOT NULL,
  raw jsonb DEFAULT '{}'::jsonb NOT NULL,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  event_at timestamp with time zone GENERATED ALWAYS AS (COALESCE(ended_at, started_at, received_at)) STORED
);

CREATE TABLE public.three_cx_missed_call_notifications (
  id uuid NOT NULL,
  history_id text NOT NULL,
  dropped_at timestamp with time zone NOT NULL,
  caller text DEFAULT ''::text NOT NULL,
  wait_seconds integer DEFAULT 0 NOT NULL,
  recipient_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.time_correction_requests (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  original_clock_in timestamp with time zone,
  original_clock_out timestamp with time zone,
  requested_clock_in timestamp with time zone,
  requested_clock_out timestamp with time zone,
  original_reported_hours numeric(10,4) DEFAULT 0 NOT NULL,
  requested_reported_hours numeric(10,4),
  reason text NOT NULL,
  status text DEFAULT 'Pending'::text NOT NULL,
  manager_note text DEFAULT ''::text NOT NULL,
  reviewed_by text DEFAULT ''::text NOT NULL,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.time_entries (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid NOT NULL,
  employee_name text NOT NULL,
  "position" text NOT NULL,
  role_group text NOT NULL,
  clock_in timestamp with time zone NOT NULL,
  clock_out timestamp with time zone,
  clock_in_lat numeric(10,7),
  clock_in_lng numeric(10,7),
  clock_in_accuracy numeric(10,2),
  clock_out_lat numeric(10,7),
  clock_out_lng numeric(10,7),
  clock_out_accuracy numeric(10,2),
  source text DEFAULT 'Corner Ops'::text NOT NULL,
  status text DEFAULT 'Open'::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.time_entry_adjustments (
  id uuid NOT NULL,
  business text NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.time_off_requests (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  reason text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'Pending'::text NOT NULL,
  manager_note text DEFAULT ''::text NOT NULL,
  reviewed_by text DEFAULT ''::text NOT NULL,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tip_overrides (
  id uuid NOT NULL,
  business text NOT NULL,
  week_start date NOT NULL,
  source_transaction_id text DEFAULT ''::text NOT NULL,
  employee_name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vendor_bill_lines (
  id uuid NOT NULL,
  bill_id uuid NOT NULL,
  line_number integer NOT NULL,
  inventory_item_id uuid,
  description text NOT NULL,
  quantity numeric(14,4) DEFAULT 1 NOT NULL,
  unit text DEFAULT 'each'::text NOT NULL,
  unit_price numeric(14,4) DEFAULT 0 NOT NULL,
  line_total numeric(14,2) DEFAULT 0 NOT NULL
);

CREATE TABLE public.vendor_bills (
  id uuid NOT NULL,
  business text NOT NULL,
  vendor text NOT NULL,
  invoice_number text DEFAULT ''::text NOT NULL,
  invoice_date date NOT NULL,
  due_date date NOT NULL,
  subtotal numeric(14,2) DEFAULT 0 NOT NULL,
  tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) NOT NULL,
  category text DEFAULT 'Other Expense'::text NOT NULL,
  account_code text DEFAULT '5900'::text NOT NULL,
  status text DEFAULT 'Open'::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  file_name text DEFAULT ''::text NOT NULL,
  content_type text DEFAULT ''::text NOT NULL,
  blob_url text DEFAULT ''::text NOT NULL,
  blob_pathname text DEFAULT ''::text NOT NULL,
  paid_bank_transaction_id uuid,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.weather_daily (
  weather_date date NOT NULL,
  source_kind text NOT NULL,
  weather_code integer DEFAULT 0 NOT NULL,
  temperature_max_f numeric(8,2) DEFAULT 0 NOT NULL,
  temperature_min_f numeric(8,2) DEFAULT 0 NOT NULL,
  temperature_mean_f numeric(8,2) DEFAULT 0 NOT NULL,
  apparent_temperature_max_f numeric(8,2) DEFAULT 0 NOT NULL,
  precipitation_in numeric(10,3) DEFAULT 0 NOT NULL,
  rain_in numeric(10,3) DEFAULT 0 NOT NULL,
  snowfall_in numeric(10,3) DEFAULT 0 NOT NULL,
  precipitation_probability integer DEFAULT 0 NOT NULL,
  wind_max_mph numeric(8,2) DEFAULT 0 NOT NULL,
  wind_gust_mph numeric(8,2) DEFAULT 0 NOT NULL,
  sunshine_hours numeric(8,2) DEFAULT 0 NOT NULL,
  fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

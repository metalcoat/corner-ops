-- Baseline tables 41-80 of 117. Generated from validated production catalog.

CREATE TABLE public.ordering_call_sessions (
  id uuid NOT NULL,
  business text NOT NULL,
  three_cx_call_id text NOT NULL,
  caller_phone text DEFAULT ''::text NOT NULL,
  customer_id uuid,
  order_id uuid,
  state text DEFAULT 'ringing'::text NOT NULL,
  owner_type text DEFAULT 'ai'::text NOT NULL,
  owner_id text DEFAULT ''::text NOT NULL,
  handoff_reason text DEFAULT ''::text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  ended_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_combo_definitions (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  prompt text DEFAULT ''::text NOT NULL,
  base_price_delta_cents integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_combo_groups (
  id uuid NOT NULL,
  combo_id uuid NOT NULL,
  name text NOT NULL,
  prompt text DEFAULT ''::text NOT NULL,
  min_selections integer DEFAULT 1 NOT NULL,
  max_selections integer DEFAULT 1 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_combo_options (
  id uuid NOT NULL,
  group_id uuid NOT NULL,
  menu_item_id uuid,
  name text NOT NULL,
  price_delta_cents integer DEFAULT 0 NOT NULL,
  available boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_customer_addresses (
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  label text DEFAULT ''::text NOT NULL,
  line1 text NOT NULL,
  line2 text DEFAULT ''::text NOT NULL,
  city text NOT NULL,
  state text NOT NULL,
  postal_code text NOT NULL,
  delivery_notes text DEFAULT ''::text NOT NULL,
  is_primary boolean DEFAULT false NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_customer_phones (
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  normalized_phone text NOT NULL,
  label text DEFAULT ''::text NOT NULL,
  is_primary boolean DEFAULT false NOT NULL,
  verified_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_customers (
  id uuid NOT NULL,
  business text NOT NULL,
  display_name text DEFAULT ''::text NOT NULL,
  first_name text DEFAULT ''::text NOT NULL,
  last_name text DEFAULT ''::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_loyalty_ledger (
  id uuid NOT NULL,
  business text NOT NULL,
  program_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid,
  entry_type text NOT NULL,
  delta_units integer NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  created_by text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_loyalty_programs (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  qualifying_rule jsonb DEFAULT '{}'::jsonb NOT NULL,
  reward_rule jsonb DEFAULT '{}'::jsonb NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_categories (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_item_combos (
  id uuid NOT NULL,
  item_id uuid NOT NULL,
  combo_id uuid NOT NULL,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_item_modifier_defaults (
  id uuid NOT NULL,
  item_id uuid NOT NULL,
  option_id uuid NOT NULL,
  default_selected boolean DEFAULT false NOT NULL,
  included_quantity integer DEFAULT 0 NOT NULL,
  price_delta_override_cents integer,
  available_override boolean,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_item_modifier_groups (
  id uuid NOT NULL,
  item_id uuid NOT NULL,
  group_id uuid NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_item_variants (
  id uuid NOT NULL,
  item_id uuid NOT NULL,
  name text NOT NULL,
  sku text DEFAULT ''::text NOT NULL,
  base_price_cents integer NOT NULL,
  default_variant boolean DEFAULT false NOT NULL,
  available boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_items (
  id uuid NOT NULL,
  business text NOT NULL,
  category_id uuid NOT NULL,
  name text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  sku text DEFAULT ''::text NOT NULL,
  base_price_cents integer NOT NULL,
  taxable boolean DEFAULT true NOT NULL,
  available boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_variant_aliases (
  id uuid NOT NULL,
  variant_id uuid NOT NULL,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_menu_variant_modifier_prices (
  id uuid NOT NULL,
  variant_id uuid NOT NULL,
  option_id uuid NOT NULL,
  price_delta_cents integer DEFAULT 0 NOT NULL,
  available boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_modifier_groups (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  prompt text DEFAULT ''::text NOT NULL,
  min_selections integer DEFAULT 0 NOT NULL,
  max_selections integer DEFAULT 1 NOT NULL,
  allow_option_quantity boolean DEFAULT false NOT NULL,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_modifier_options (
  id uuid NOT NULL,
  group_id uuid NOT NULL,
  name text NOT NULL,
  price_delta_cents integer DEFAULT 0 NOT NULL,
  available boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_order_events (
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_version integer NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text DEFAULT ''::text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_order_item_combo_selections (
  id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  combo_id uuid NOT NULL,
  group_id uuid NOT NULL,
  option_id uuid NOT NULL,
  combo_name_snapshot text NOT NULL,
  group_name_snapshot text NOT NULL,
  option_name_snapshot text NOT NULL,
  price_delta_cents integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_order_item_modifiers (
  id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  group_id uuid NOT NULL,
  option_id uuid NOT NULL,
  group_name_snapshot text NOT NULL,
  option_name_snapshot text NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  unit_price_delta_cents integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  selection_state text DEFAULT 'selected'::text NOT NULL
);

CREATE TABLE public.ordering_order_items (
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  item_id uuid NOT NULL,
  item_name_snapshot text NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  unit_price_cents integer NOT NULL,
  modifier_total_cents integer DEFAULT 0 NOT NULL,
  line_total_cents integer NOT NULL,
  special_instructions text DEFAULT ''::text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  combo_name_snapshot text DEFAULT ''::text NOT NULL,
  combo_total_cents integer DEFAULT 0 NOT NULL,
  variant_id uuid,
  variant_name_snapshot text DEFAULT ''::text NOT NULL,
  variant_sku_snapshot text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.ordering_orders (
  id uuid NOT NULL,
  business text NOT NULL,
  source text NOT NULL,
  customer_id uuid,
  caller_phone text DEFAULT ''::text NOT NULL,
  three_cx_call_id text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  payment_status text DEFAULT 'unpaid'::text NOT NULL,
  service_type text DEFAULT 'pickup'::text NOT NULL,
  version integer DEFAULT 1 NOT NULL,
  subtotal_cents integer DEFAULT 0 NOT NULL,
  discount_cents integer DEFAULT 0 NOT NULL,
  tax_cents integer DEFAULT 0 NOT NULL,
  tip_cents integer DEFAULT 0 NOT NULL,
  total_cents integer DEFAULT 0 NOT NULL,
  paid_cents integer DEFAULT 0 NOT NULL,
  amount_due_cents integer DEFAULT 0 NOT NULL,
  promised_at timestamp with time zone,
  special_instructions text DEFAULT ''::text NOT NULL,
  handoff_reason text DEFAULT ''::text NOT NULL,
  created_by text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  sms_verified_at timestamp with time zone,
  arrival_status text DEFAULT 'not_expected'::text NOT NULL,
  arrived_at timestamp with time zone,
  arrival_acknowledged_at timestamp with time zone,
  arrival_details text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.ordering_sms_verifications (
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  phone text NOT NULL,
  purpose text DEFAULT 'unpaid_web_order'::text NOT NULL,
  code_hash text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  max_attempts integer DEFAULT 5 NOT NULL,
  resend_count integer DEFAULT 0 NOT NULL,
  sent_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  verified_at timestamp with time zone,
  invalidated_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ordering_upsell_rules (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  condition_rule jsonb DEFAULT '{}'::jsonb NOT NULL,
  offer_rule jsonb DEFAULT '{}'::jsonb NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.overtime_risk_alerts (
  id uuid NOT NULL,
  business text NOT NULL,
  employee_id uuid NOT NULL,
  week_start date NOT NULL,
  risk_level text NOT NULL,
  signature text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'Open'::text NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_notified_at timestamp with time zone,
  resolved_at timestamp with time zone
);

CREATE TABLE public.owner_message_notification_state (
  reader_email text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.owner_message_reads (
  message_id uuid NOT NULL,
  reader_email text NOT NULL,
  read_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.payroll_audit_events (
  id uuid NOT NULL,
  business text NOT NULL,
  event_type text NOT NULL,
  reference_id text DEFAULT ''::text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  actor text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.payroll_run_versions (
  id uuid NOT NULL,
  business text NOT NULL,
  week_start date NOT NULL,
  week_end timestamp with time zone NOT NULL,
  version integer NOT NULL,
  status text DEFAULT 'Draft'::text NOT NULL,
  payload jsonb NOT NULL,
  generated_by text NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  locked_by text,
  locked_at timestamp with time zone,
  reopened_from_id uuid
);

CREATE TABLE public.payroll_runs (
  id uuid NOT NULL,
  business text NOT NULL,
  week_start date NOT NULL,
  week_end timestamp with time zone NOT NULL,
  status text DEFAULT 'Calculated'::text NOT NULL,
  payload jsonb NOT NULL,
  generated_by text NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.push_delivery_log (
  id uuid NOT NULL,
  subscription_id uuid,
  category text DEFAULT 'message'::text NOT NULL,
  title text NOT NULL,
  destination_url text DEFAULT ''::text NOT NULL,
  status text NOT NULL,
  response_status integer,
  error text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.push_subscriptions (
  id uuid NOT NULL,
  endpoint text NOT NULL,
  audience_type text NOT NULL,
  owner_email text DEFAULT ''::text NOT NULL,
  employee_id uuid,
  business text,
  p256dh text NOT NULL,
  auth text NOT NULL,
  expiration_time bigint,
  user_agent text DEFAULT ''::text NOT NULL,
  device_label text DEFAULT ''::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  failure_count integer DEFAULT 0 NOT NULL,
  last_error text DEFAULT ''::text NOT NULL,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.receipt_documents (
  id uuid NOT NULL,
  business text NOT NULL,
  source text NOT NULL,
  source_key text NOT NULL,
  external_file_id text DEFAULT ''::text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint DEFAULT 0 NOT NULL,
  source_url text DEFAULT ''::text NOT NULL,
  storage_url text DEFAULT ''::text NOT NULL,
  storage_pathname text DEFAULT ''::text NOT NULL,
  modified_at_source timestamp with time zone,
  ocr_status text DEFAULT 'Pending'::text NOT NULL,
  merchant_name text DEFAULT ''::text NOT NULL,
  receipt_date date,
  total_amount numeric(14,2),
  tax_amount numeric(14,2),
  currency text DEFAULT 'USD'::text NOT NULL,
  raw_text text DEFAULT ''::text NOT NULL,
  entities jsonb DEFAULT '{}'::jsonb NOT NULL,
  ocr_error text DEFAULT ''::text NOT NULL,
  created_by text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.receipt_transaction_matches (
  id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  business text NOT NULL,
  confidence numeric(5,4) DEFAULT 0 NOT NULL,
  amount_variance numeric(14,2) DEFAULT 0 NOT NULL,
  date_difference integer DEFAULT 0 NOT NULL,
  merchant_score numeric(5,4) DEFAULT 0 NOT NULL,
  status text DEFAULT 'Suggested'::text NOT NULL,
  matched_by text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  matched_at timestamp with time zone
);

CREATE TABLE public.recipe_components (
  id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(14,4) NOT NULL,
  unit text NOT NULL,
  waste_percent numeric(6,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.recipes (
  id uuid NOT NULL,
  business text NOT NULL,
  product_name text NOT NULL,
  yield_quantity numeric(14,4) DEFAULT 1 NOT NULL,
  selling_price numeric(14,2) DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.recurring_invoice_templates (
  id uuid NOT NULL,
  business text NOT NULL,
  name text NOT NULL,
  customer_name text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  amount numeric(14,2) NOT NULL,
  revenue_account_code text NOT NULL,
  cadence text NOT NULL,
  due_days integer DEFAULT 0 NOT NULL,
  next_issue_date date NOT NULL,
  label_template text DEFAULT '{period}'::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.rezku_data_migrations (
  migration_key text NOT NULL,
  completed_at timestamp with time zone DEFAULT now() NOT NULL
);

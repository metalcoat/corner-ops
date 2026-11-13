-- Car tablet: a dedicated Android tablet mounted in the delivery car (tools/car-tablet).
-- Paired from POS Settings › Car tablet with a short code; the tablet then sends a long-lived
-- bearer token (only its SHA-256 is stored). Revoking clears the token.
CREATE TABLE IF NOT EXISTS car_tablets (
  id uuid PRIMARY KEY,
  business text NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  name text NOT NULL,
  token_hash text UNIQUE,
  pairing_code_hash text UNIQUE,
  pairing_expires_at timestamptz,
  paired_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  -- The driver signed in on the tablet with their POS PIN (NULL: the only Driver on the clock, if exactly one).
  driver_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  driver_signed_in_at timestamptz,
  -- Latest heartbeat.
  last_seen_at timestamptz,
  battery_percent integer,
  charging boolean,
  network_type text NOT NULL DEFAULT '',
  signal_level integer,
  app_version text NOT NULL DEFAULT '',
  device_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Latest GPS point (also in car_tablet_locations).
  last_latitude numeric(10,7),
  last_longitude numeric(10,7),
  last_accuracy_meters numeric(9,2),
  last_speed_mps numeric(7,2),
  last_heading numeric(6,2),
  last_location_at timestamptz
);
CREATE INDEX IF NOT EXISTS car_tablets_business_idx ON car_tablets (business) WHERE revoked_at IS NULL;

-- Every point the tablet records, delivery or not. Points during an active delivery are also
-- copied into ordering_delivery_locations so the dispatch map and customer tracking see them.
CREATE TABLE IF NOT EXISTS car_tablet_locations (
  id uuid PRIMARY KEY,
  tablet_id uuid NOT NULL REFERENCES car_tablets(id) ON DELETE CASCADE,
  driver_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  client_event_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT NOW(),
  latitude numeric(10,7) NOT NULL,
  longitude numeric(10,7) NOT NULL,
  accuracy_meters numeric(9,2),
  speed_mps numeric(7,2),
  heading numeric(6,2),
  UNIQUE (tablet_id, client_event_id)
);
CREATE INDEX IF NOT EXISTS car_tablet_locations_time_idx ON car_tablet_locations (tablet_id, captured_at DESC);

-- "Snap now" and other requests from the POS, picked up by the tablet's long poll.
CREATE TABLE IF NOT EXISTS car_tablet_commands (
  id uuid PRIMARY KEY,
  tablet_id uuid NOT NULL REFERENCES car_tablets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('snap')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS car_tablet_commands_pending_idx ON car_tablet_commands (tablet_id, created_at) WHERE completed_at IS NULL;

-- Photos from the cabin (front camera) and road (rear camera, through the windshield).
-- Files live in the uploads volume (car-tablet/...), which the nightly backup already archives.
CREATE TABLE IF NOT EXISTS car_tablet_photos (
  id uuid PRIMARY KEY,
  tablet_id uuid NOT NULL REFERENCES car_tablets(id) ON DELETE CASCADE,
  business text NOT NULL,
  client_photo_id text NOT NULL,
  camera text NOT NULL CHECK (camera IN ('cabin', 'road')),
  reason text NOT NULL CHECK (reason IN ('manual', 'delivery_complete', 'remote_request')),
  command_id uuid REFERENCES car_tablet_commands(id) ON DELETE SET NULL,
  order_id uuid REFERENCES ordering_orders(id) ON DELETE SET NULL,
  delivery_id uuid REFERENCES ordering_delivery_assignments(id) ON DELETE SET NULL,
  driver_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  storage_reference text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  captured_at timestamptz NOT NULL,
  latitude numeric(10,7),
  longitude numeric(10,7),
  accuracy_meters numeric(9,2),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tablet_id, client_photo_id)
);
CREATE INDEX IF NOT EXISTS car_tablet_photos_time_idx ON car_tablet_photos (tablet_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS car_tablet_photos_order_idx ON car_tablet_photos (order_id) WHERE order_id IS NOT NULL;

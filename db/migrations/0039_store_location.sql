-- Persist the geocoded store address used by the ordering map and delivery routes.
-- deliLocation() already reads/writes this cache; explicit origin coordinates
-- still take precedence. Keep schema creation in migrations, not request handlers.
CREATE TABLE IF NOT EXISTS ordering_store_locations (
  address text PRIMARY KEY,
  latitude numeric(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  formatted_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

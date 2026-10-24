-- Greeter TV volumes, set by managers in POS Settings > Operations (0-100).
CREATE TABLE IF NOT EXISTS greeter_tv_settings (
  business text PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
  music_volume integer NOT NULL DEFAULT 13 CHECK (music_volume BETWEEN 0 AND 100),
  greeting_volume integer NOT NULL DEFAULT 100 CHECK (greeting_volume BETWEEN 0 AND 100),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO greeter_tv_settings (business) VALUES ('Corner Deli') ON CONFLICT (business) DO NOTHING;

-- Employee drinks at cost (Corner Deli POS). The employee price is worked out from these:
-- (cost + bottle deposit) with sales tax, rounded up to the next $0.25. Costs change, so a
-- manager edits them in POS settings > Operations. 2026-11-06 costs from Chris.
CREATE TABLE IF NOT EXISTS ordering_employee_drink_prices (
  business text NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  size_key text NOT NULL,
  label text NOT NULL,
  category_name text NOT NULL,
  cost_cents integer NOT NULL CHECK (cost_cents >= 0),
  deposit_cents integer NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business, size_key)
);
INSERT INTO ordering_employee_drink_prices (business, size_key, label, category_name, cost_cents, deposit_cents, updated_by)
VALUES ('Corner Deli', '20oz', '20 oz bottle', 'Drinks & Chips / 12 - 20 oz Soda', 129, 5, 'initial (Chris 2026-11-06)'),
       ('Corner Deli', '2l', '2 liter', 'Drinks & Chips / 2 Liter', 205, 5, 'initial (Chris 2026-11-06)')
ON CONFLICT (business, size_key) DO NOTHING;

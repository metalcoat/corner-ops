-- Curbside check-in: the customer taps "I'm here" and picks their car, and the greeter TV alerts staff.
CREATE TABLE IF NOT EXISTS ordering_curbside_arrivals (
  id BIGSERIAL PRIMARY KEY,
  business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
  order_id UUID NOT NULL UNIQUE REFERENCES ordering_orders(id) ON DELETE CASCADE,
  car_color TEXT NOT NULL,
  car_type TEXT NOT NULL,
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_curbside_arrivals_recent
ON ordering_curbside_arrivals (business, arrived_at DESC);

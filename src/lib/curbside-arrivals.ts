import { getSql } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";
import { carLabel, CURBSIDE_CHECK_IN_STATUSES, CURBSIDE_SHOW_MINUTES } from "@/lib/curbside-arrival-policy";

let schemaPromise: Promise<void> | null = null;

/** Mirrors db/migrations/0034_curbside_arrivals.sql for databases that haven't run it. */
export function ensureCurbsideArrivalSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureOrderingSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_curbside_arrivals (
          id BIGSERIAL PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          order_id UUID NOT NULL UNIQUE REFERENCES ordering_orders(id) ON DELETE CASCADE,
          car_color TEXT NOT NULL,
          car_type TEXT NOT NULL,
          arrived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_curbside_arrivals_recent ON ordering_curbside_arrivals (business, arrived_at DESC)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

/** Records "I'm here". A second tap updates the car but keeps the first arrival, so the TV doesn't ring twice. */
export async function recordCurbsideArrival(orderId: string, business: string, car: { carColor: string; carType: string }) {
  await ensureCurbsideArrivalSchema();
  await getSql()`
    INSERT INTO ordering_curbside_arrivals (business, order_id, car_color, car_type)
    VALUES (${business}, ${orderId}, ${car.carColor}, ${car.carType})
    ON CONFLICT (order_id) DO UPDATE SET car_color = EXCLUDED.car_color, car_type = EXCLUDED.car_type
  `;
}

export async function curbsideArrivalForOrder(orderId: string) {
  await ensureCurbsideArrivalSchema();
  const row = (await getSql()`SELECT car_color, car_type FROM ordering_curbside_arrivals WHERE order_id = ${orderId}`)[0];
  return row ? { carColor: String(row.car_color), carType: String(row.car_type) } : null;
}

/** Customers waiting outside right now, oldest first, for the greeter TV. */
export async function waitingCurbsideArrivals(business: string) {
  await ensureCurbsideArrivalSchema();
  const rows = await getSql()`
    SELECT a.id, a.car_color, a.car_type, o.display_number,
      trim(o.first_name_snapshot || ' ' || o.last_name_snapshot) AS customer_name
    FROM ordering_curbside_arrivals a JOIN ordering_orders o ON o.id = a.order_id
    WHERE a.business = ${business}
      AND a.arrived_at > NOW() - make_interval(mins => ${CURBSIDE_SHOW_MINUTES})
      AND o.status = ANY(${CURBSIDE_CHECK_IN_STATUSES})
    ORDER BY a.arrived_at
    LIMIT 4
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.customer_name || "Curbside customer"),
    car: carLabel(String(row.car_color), String(row.car_type)),
    orderNumber: String(row.display_number || ""),
  }));
}

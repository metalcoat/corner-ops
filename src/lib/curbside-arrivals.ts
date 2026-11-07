import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { carLabel, CURBSIDE_CHECK_IN_STATUSES, CURBSIDE_SHOW_MINUTES } from "@/lib/curbside-arrival-policy";
import type { OrderingActor } from "@/lib/ordering-route-auth";

// Table: db/migrations/0034_curbside_arrivals.sql, delivered columns 0035_curbside_delivered.sql.

/** Records "I'm here". A second tap updates the car but keeps the first arrival, so the store PC doesn't alert twice. */
export async function recordCurbsideArrival(orderId: string, business: string, car: { carColor: string; carType: string }) {
  await getSql()`
    INSERT INTO ordering_curbside_arrivals (business, order_id, car_color, car_type)
    VALUES (${business}, ${orderId}, ${car.carColor}, ${car.carType})
    ON CONFLICT (order_id) DO UPDATE SET car_color = EXCLUDED.car_color, car_type = EXCLUDED.car_type
  `;
}

export async function curbsideArrivalForOrder(orderId: string) {
  const row = (await getSql()`SELECT car_color, car_type FROM ordering_curbside_arrivals WHERE order_id = ${orderId}`)[0];
  return row ? { carColor: String(row.car_color), carType: String(row.car_type) } : null;
}

/** Customers waiting outside right now, oldest first: checked in, not yet brought out, order not finished. */
async function waitingRows(business: string) {
  return getSql()`
    SELECT a.id, a.order_id, a.car_color, a.car_type, o.display_number,
      trim(o.first_name_snapshot || ' ' || o.last_name_snapshot) AS customer_name,
      floor(extract(epoch FROM NOW() - a.arrived_at) / 60)::int AS waiting_minutes
    FROM ordering_curbside_arrivals a JOIN ordering_orders o ON o.id = a.order_id
    WHERE a.business = ${business}
      AND a.delivered_at IS NULL
      AND a.arrived_at > NOW() - make_interval(mins => ${CURBSIDE_SHOW_MINUTES})
      AND o.status = ANY(${CURBSIDE_CHECK_IN_STATUSES})
    ORDER BY a.arrived_at
    LIMIT 8
  `;
}

/** For the store PC's curbside alert (GET /api/pos/greeter/arrivals, no sign-in): just what it shows. */
export async function waitingCurbsideArrivals(business: string) {
  return (await waitingRows(business)).map((row) => ({
    id: Number(row.id),
    name: String(row.customer_name || "Curbside customer"),
    car: carLabel(String(row.car_color), String(row.car_type)),
    orderNumber: String(row.display_number || ""),
  }));
}

/** For the POS (signed-in staff): also the order and how long they've waited. */
export async function posCurbsideArrivals(business: string) {
  return (await waitingRows(business)).map((row) => ({
    id: Number(row.id),
    orderId: String(row.order_id),
    name: String(row.customer_name || "Curbside customer"),
    car: carLabel(String(row.car_color), String(row.car_type)),
    orderNumber: String(row.display_number || ""),
    waitingMinutes: Number(row.waiting_minutes || 0),
  }));
}

/**
 * Staff brought the order out to the car: records who and when, adds it to the order's
 * "Who did what", and the arrival stops being listed (the store PC's popup closes).
 * Returns false when it was already marked or isn't this business's.
 */
export async function markCurbsideDelivered(arrivalId: number, business: string, actor: OrderingActor): Promise<boolean> {
  const rows = await getSql()`
    WITH done AS (
      UPDATE ordering_curbside_arrivals
      SET delivered_at = NOW(), delivered_by_id = ${actor.id}, delivered_by_name = ${actor.name}
      WHERE id = ${arrivalId} AND business = ${business} AND delivered_at IS NULL
      RETURNING order_id, car_color, car_type, arrived_at
    )
    INSERT INTO ordering_order_events (id, order_id, order_version, event_type, actor_type, actor_id, details)
    SELECT ${randomUUID()}, o.id, o.version, 'curbside_delivered', ${actor.type}, ${actor.id},
      jsonb_build_object('carColor', done.car_color, 'carType', done.car_type, 'arrivedAt', done.arrived_at,
        'actorName', ${actor.name}::text, 'actorRole', ${actor.role || null}::text)
    FROM done JOIN ordering_orders o ON o.id = done.order_id
    RETURNING order_id
  `;
  return rows.length > 0;
}

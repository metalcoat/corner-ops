import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let timingSchemaPromise: Promise<void> | null = null;

/**
 * Shared restaurant hours, ASAP estimates, future-order rules, and kitchen
 * timing snapshots. These settings are deliberately channel-independent so
 * POS, web, and AI phone ordering quote the same availability and wait times.
 */
export function ensureOrderingTimingSchema(): Promise<void> {
  if (!timingSchemaPromise) {
    timingSchemaPromise = (async () => {
      await ensureOrderingPosSchema();
      const sql = getSql();
      await sql`
        INSERT INTO ordering_business_ordering_settings (business)
        VALUES ('Corner Deli'), ('Tiki')
        ON CONFLICT (business) DO NOTHING
      `;
      await sql`
        INSERT INTO ordering_operating_windows (
          id, business, service_type, weekday, opens_at, closes_at, active, sort_order, updated_by, created_at, updated_at
        )
        SELECT id, business, 'all', weekday, opens_at, closes_at, active AND accepts_orders, sort_order, created_by, created_at, updated_at
        FROM ordering_business_hours legacy
        WHERE NOT EXISTS (
          SELECT 1 FROM ordering_operating_windows current
          WHERE current.business = legacy.business AND current.service_type = 'all'
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // Stated Corner Deli timing. Eight active orders in the rolling
      // 15-minute window is the initial automatic surge threshold.
      await sql`
        INSERT INTO ordering_fulfillment_timing_settings (
          business, service_type, normal_min_minutes, normal_max_minutes,
          busy_min_minutes, busy_max_minutes, busy_window_minutes
        ) VALUES
          ('Corner Deli', 'pickup', 30, 30, 60, 60, 15),
          ('Corner Deli', 'curbside', 30, 30, 60, 60, 15),
          ('Corner Deli', 'delivery', 40, 45, 60, 60, 15),
          ('Corner Deli', 'no_contact_delivery', 40, 45, 60, 60, 15)
        ON CONFLICT (business, service_type) DO NOTHING
      `;
      await sql`
        UPDATE ordering_fulfillment_timing_settings
        SET busy_order_threshold=8,updated_by='corner-deli-surge-default',updated_at=NOW()
        WHERE business='Corner Deli'
          AND service_type IN ('pickup','curbside','delivery','no_contact_delivery')
          AND busy_order_threshold IS NULL
      `;
    })().catch((error) => {
      timingSchemaPromise = null;
      throw error;
    });
  }

  return timingSchemaPromise;
}

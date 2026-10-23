import { getSql } from "@/lib/db";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";

let deliverySchemaPromise: Promise<void> | null = null;

/**
 * Delivery/tax configuration is business-owned and version-safe. Current
 * settings drive new orders while every confirmed order snapshots the values
 * used at the time of sale.
 */
export function ensureOrderingDeliverySchema(): Promise<void> {
  if (!deliverySchemaPromise) {
    deliverySchemaPromise = (async () => {
      await ensureOrderingChannelSchema();
      const sql = getSql();
      await sql`
        INSERT INTO ordering_business_tax_settings (business, prices_include_tax)
        VALUES ('Corner Deli', TRUE), ('Tiki', TRUE)
        ON CONFLICT (business) DO NOTHING
      `;

      // Corner Deli policy: $16.00 of merchandise is required for delivery.
      // The mileage-based delivery fee is then added on top. The customer may
      // choose a useful add-on or an exact round-up adjustment if short.
      await sql`
        INSERT INTO ordering_delivery_policies (
          business, enabled, minimum_order_cents, minimum_basis,
          offer_upsell_before_shortfall_fee, allow_shortfall_fee,
          shortfall_fee_label, allow_manager_bypass,
          notify_management_on_bypass, max_distance_miles
        ) VALUES (
          'Corner Deli', TRUE, 1600, 'merchandise_after_discounts',
          TRUE, TRUE, 'Round up to delivery minimum', TRUE, TRUE, 12
        )
        ON CONFLICT (business) DO UPDATE SET
          minimum_order_cents = 1600,
          minimum_basis = 'merchandise_after_discounts',
          shortfall_fee_label = 'Round up to delivery minimum',
          updated_at = NOW()
      `;

      // Working contiguous delivery pricing. Every boundary and fee remains
      // owner-editable before production.
      await sql`
        INSERT INTO ordering_delivery_fee_bands (id, business, min_miles, max_miles, fee_cents, sort_order)
        VALUES
          ('0f8b0abc-2cb9-4fb6-b9bd-8b2e0a000401', 'Corner Deli', 0, 4, 400, 10),
          ('0f8b0abc-2cb9-4fb6-b9bd-8b2e0a000402', 'Corner Deli', 4, 8, 775, 20),
          ('0f8b0abc-2cb9-4fb6-b9bd-8b2e0a000403', 'Corner Deli', 8, 12, 1000, 30)
        ON CONFLICT (business, min_miles, max_miles) DO UPDATE SET
          fee_cents = EXCLUDED.fee_cents,
          active = TRUE,
          sort_order = EXCLUDED.sort_order,
          updated_at = NOW()
      `;
    })().catch((error) => {
      deliverySchemaPromise = null;
      throw error;
    });
  }

  return deliverySchemaPromise;
}

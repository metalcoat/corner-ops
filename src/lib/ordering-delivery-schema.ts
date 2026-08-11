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
        CREATE TABLE IF NOT EXISTS ordering_business_tax_settings (
          business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
          prices_include_tax BOOLEAN NOT NULL DEFAULT TRUE,
          tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
          tax_rate_configured BOOLEAN NOT NULL DEFAULT FALSE,
          delivery_fee_taxable BOOLEAN NOT NULL DEFAULT TRUE,
          minimum_adjustment_taxable BOOLEAN NOT NULL DEFAULT TRUE,
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        INSERT INTO ordering_business_tax_settings (business, prices_include_tax)
        VALUES ('Corner Deli', TRUE), ('Tiki', TRUE)
        ON CONFLICT (business) DO NOTHING
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_delivery_policies (
          business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          minimum_order_cents INTEGER NOT NULL DEFAULT 0 CHECK (minimum_order_cents >= 0),
          minimum_basis TEXT NOT NULL DEFAULT 'merchandise_after_discounts',
          offer_upsell_before_shortfall_fee BOOLEAN NOT NULL DEFAULT TRUE,
          allow_shortfall_fee BOOLEAN NOT NULL DEFAULT TRUE,
          shortfall_fee_label TEXT NOT NULL DEFAULT 'Round up to delivery minimum',
          allow_manager_bypass BOOLEAN NOT NULL DEFAULT TRUE,
          notify_management_on_bypass BOOLEAN NOT NULL DEFAULT TRUE,
          max_distance_miles NUMERIC(6,2),
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (max_distance_miles IS NULL OR max_distance_miles > 0)
        )
      `;

      await sql`ALTER TABLE ordering_delivery_policies DROP CONSTRAINT IF EXISTS ordering_delivery_policies_minimum_basis_check`;
      await sql`ALTER TABLE ordering_delivery_policies ALTER COLUMN minimum_basis SET DEFAULT 'merchandise_after_discounts'`;
      await sql`
        ALTER TABLE ordering_delivery_policies
        ADD CONSTRAINT ordering_delivery_policies_minimum_basis_check
        CHECK (minimum_basis IN ('merchandise_after_discounts', 'order_total_including_delivery_fee'))
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

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_delivery_fee_bands (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          min_miles NUMERIC(6,2) NOT NULL CHECK (min_miles >= 0),
          max_miles NUMERIC(6,2) NOT NULL CHECK (max_miles > 0),
          fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          updated_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (max_miles > min_miles),
          UNIQUE (business, min_miles, max_miles)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_delivery_fee_bands_lookup_idx ON ordering_delivery_fee_bands (business, active, sort_order, max_miles)`;

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

      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS delivery_distance_miles NUMERIC(6,2)`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS delivery_fee_cents INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS minimum_order_cents_snapshot INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS minimum_order_adjustment_cents INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS tax_rate_bps_snapshot INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS prices_include_tax_snapshot BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_delivery_distance_check`;
      await sql`ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_delivery_distance_check CHECK (delivery_distance_miles IS NULL OR delivery_distance_miles >= 0)`;
      await sql`ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_delivery_fee_check`;
      await sql`
        ALTER TABLE ordering_orders
        ADD CONSTRAINT ordering_orders_delivery_fee_check
        CHECK (
          delivery_fee_cents >= 0
          AND minimum_order_cents_snapshot >= 0
          AND minimum_order_adjustment_cents >= 0
          AND tax_rate_bps_snapshot >= 0
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_delivery_minimum_exceptions (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          resolution_type TEXT NOT NULL CHECK (resolution_type IN ('shortfall_fee', 'bypass')),
          minimum_order_cents INTEGER NOT NULL CHECK (minimum_order_cents >= 0),
          merchandise_subtotal_cents INTEGER NOT NULL CHECK (merchandise_subtotal_cents >= 0),
          shortfall_cents INTEGER NOT NULL CHECK (shortfall_cents >= 0),
          adjustment_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (adjustment_fee_cents >= 0),
          upsell_offered BOOLEAN NOT NULL DEFAULT FALSE,
          customer_declined_upsell BOOLEAN NOT NULL DEFAULT FALSE,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('ai', 'employee', 'web', 'system')),
          actor_id TEXT NOT NULL DEFAULT '',
          approved_by TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (
            (resolution_type = 'shortfall_fee' AND adjustment_fee_cents = shortfall_cents)
            OR (resolution_type = 'bypass' AND adjustment_fee_cents = 0)
          )
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_delivery_minimum_exceptions_order_idx ON ordering_delivery_minimum_exceptions (order_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_delivery_minimum_exceptions_business_idx ON ordering_delivery_minimum_exceptions (business, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_management_alerts (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          order_id UUID REFERENCES ordering_orders(id) ON DELETE CASCADE,
          alert_type TEXT NOT NULL CHECK (alert_type IN ('delivery_minimum_bypass')),
          severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          acknowledged_by TEXT NOT NULL DEFAULT '',
          acknowledged_at TIMESTAMPTZ,
          resolved_at TIMESTAMPTZ,
          details JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_management_alerts_open_idx ON ordering_management_alerts (business, status, created_at DESC)`;
    })().catch((error) => {
      deliverySchemaPromise = null;
      throw error;
    });
  }

  return deliverySchemaPromise;
}

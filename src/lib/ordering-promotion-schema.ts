import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let ready: Promise<void> | null = null;

export function ensureOrderingPromotionSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await ensureOrderingPosSchema();
    const sql = getSql();
    await sql`ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS customer_label TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS internal_description TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`;
    await sql`ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS automatic BOOLEAN NOT NULL DEFAULT TRUE`;
    await sql`ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS stackable_with_loyalty BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE ordering_promotions ADD COLUMN IF NOT EXISTS exclusive_group TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS gross_base_merchandise_cents INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS modifier_revenue_cents INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS promotion_discount_cents INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS loyalty_discount_cents INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS net_merchandise_cents INTEGER NOT NULL DEFAULT 0`;
    await sql`
      CREATE TABLE IF NOT EXISTS ordering_order_promotion_applications (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
        promotion_id UUID REFERENCES ordering_promotions(id),
        promotion_version INTEGER NOT NULL,
        label_snapshot TEXT NOT NULL,
        configuration_snapshot JSONB NOT NULL,
        normal_base_subtotal_cents INTEGER NOT NULL CHECK(normal_base_subtotal_cents >= 0),
        discount_cents INTEGER NOT NULL CHECK(discount_cents >= 0),
        resulting_base_subtotal_cents INTEGER NOT NULL CHECK(resulting_base_subtotal_cents >= 0),
        application_sequence INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(order_id, application_sequence)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS ordering_order_promotion_allocations (
        id UUID PRIMARY KEY,
        application_id UUID NOT NULL REFERENCES ordering_order_promotion_applications(id) ON DELETE CASCADE,
        order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
        consumed_quantity INTEGER NOT NULL CHECK(consumed_quantity > 0),
        normal_base_cents INTEGER NOT NULL CHECK(normal_base_cents >= 0),
        discount_cents INTEGER NOT NULL CHECK(discount_cents >= 0),
        UNIQUE(application_id, order_item_id)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS ordering_order_promotions_order_idx ON ordering_order_promotion_applications(order_id, application_sequence)`;
    await sql`ALTER TABLE ordering_order_promotion_allocations DROP CONSTRAINT IF EXISTS ordering_order_promotion_allocations_order_item_id_fkey`;
    await sql`ALTER TABLE ordering_order_promotion_allocations ADD CONSTRAINT ordering_order_promotion_allocations_order_item_id_fkey FOREIGN KEY(order_item_id) REFERENCES ordering_order_items(id) ON DELETE CASCADE`;
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

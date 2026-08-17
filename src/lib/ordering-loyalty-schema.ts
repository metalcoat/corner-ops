import { getSql } from "@/lib/db";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";

let ready: Promise<void> | null = null;

export function ensureOrderingLoyaltySchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await ensureOrderingPromotionSchema();
    const sql = getSql();
    await sql`ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS customer_name TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`;
    await sql`ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 10000`;
    await sql`ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS stackable BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE ordering_loyalty_programs ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES ordering_order_items(id)`;
    await sql`ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS related_event_id UUID REFERENCES ordering_loyalty_ledger(id)`;
    await sql`ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_loyalty_ledger ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
    await sql`ALTER TABLE ordering_loyalty_ledger DROP CONSTRAINT IF EXISTS ordering_loyalty_ledger_entry_type_check`;
    await sql`ALTER TABLE ordering_loyalty_ledger ADD CONSTRAINT ordering_loyalty_ledger_entry_type_check CHECK(entry_type IN ('earn','redeem','void_reversal','redemption_reversal','manager_adjustment','reversal','adjustment','expire'))`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_loyalty_earn_once_idx ON ordering_loyalty_ledger(program_id,order_id) WHERE entry_type='earn'`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_loyalty_reverse_once_idx ON ordering_loyalty_ledger(related_event_id,entry_type) WHERE related_event_id IS NOT NULL`;
    await sql`
      CREATE TABLE IF NOT EXISTS ordering_order_loyalty_applications (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
        order_item_id UUID NOT NULL REFERENCES ordering_order_items(id),
        customer_id UUID NOT NULL REFERENCES ordering_customers(id),
        program_id UUID NOT NULL REFERENCES ordering_loyalty_programs(id),
        program_version INTEGER NOT NULL,
        label_snapshot TEXT NOT NULL,
        configuration_snapshot JSONB NOT NULL,
        consumed_quantity INTEGER NOT NULL DEFAULT 1 CHECK(consumed_quantity > 0),
        base_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(base_discount_cents >= 0),
        modifier_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(modifier_discount_cents >= 0),
        discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
        redemption_event_id UUID REFERENCES ordering_loyalty_ledger(id),
        requested_by TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(order_id, program_id, order_item_id)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS ordering_order_loyalty_order_idx ON ordering_order_loyalty_applications(order_id,applied_at)`;
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

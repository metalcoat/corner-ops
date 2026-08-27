import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";

const JUMBO_THIN_LOYALTY_ID = "9f2ea950-10c0-4c2b-bf19-00c8d19f6210";

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
    const jumboThin = await sql`
      SELECT variant.id
      FROM ordering_menu_item_variants variant
      JOIN ordering_menu_items item ON item.id=variant.item_id
      WHERE item.business='Corner Deli' AND item.name='Pizza'
        AND variant.name='Jumbo Thin 16"' AND item.active=TRUE AND variant.active=TRUE
      LIMIT 1
    `;
    if (jumboThin[0]) {
      const variantIds = [String(jumboThin[0].id)];
      await sql`
        INSERT INTO ordering_loyalty_programs(
          id,business,name,customer_name,description,qualifying_rule,reward_rule,
          active,version,priority,stackable,updated_by
        ) VALUES(
          ${JUMBO_THIN_LOYALTY_ID},'Corner Deli','Jumbo Thin Pizza Loyalty',
          'Jumbo Thin Pizza Rewards','Buy 10 Jumbo Thin pizzas and get one free.',
          ${JSON.stringify({variantIds,quantityRequired:10,channels:[],serviceTypes:[],discountedItemsQualify:true})}::jsonb,
          ${JSON.stringify({variantIds,quantity:1,modifierAllowances:[],expirationDays:null})}::jsonb,
          TRUE,1,10000,FALSE,'system'
        )
        ON CONFLICT (business,name) DO NOTHING
      `;
      const [loyaltyProgram] = await sql`
        SELECT id FROM ordering_loyalty_programs
        WHERE business='Corner Deli' AND name='Jumbo Thin Pizza Loyalty'
      `;
      const acceptedOrders = await sql`
        SELECT orders.id order_id,orders.customer_id,SUM(line.quantity)::integer units
        FROM ordering_orders orders
        JOIN ordering_order_items line ON line.order_id=orders.id
        WHERE orders.business='Corner Deli' AND orders.customer_id IS NOT NULL
          AND orders.status IN ('sent_to_kitchen','in_progress','ready','completed')
          AND line.variant_id=${variantIds[0]}
        GROUP BY orders.id,orders.customer_id
      `;
      for (const order of acceptedOrders) {
        await sql`
          INSERT INTO ordering_loyalty_ledger(
            id,business,program_id,customer_id,order_id,entry_type,delta_units,
            description,created_by,metadata
          ) VALUES(
            ${randomUUID()},'Corner Deli',${String(loyaltyProgram.id)},${order.customer_id},
            ${order.order_id},'earn',${Number(order.units)},'Jumbo Thin Pizza Loyalty',
            'system-backfill',${JSON.stringify({quantity:Number(order.units),reason:"Program activation"})}::jsonb
          ) ON CONFLICT DO NOTHING
        `;
      }
    }
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

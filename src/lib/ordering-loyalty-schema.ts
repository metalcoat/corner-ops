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
          ) SELECT
            ${randomUUID()}::uuid,'Corner Deli',${String(loyaltyProgram.id)}::uuid,${order.customer_id}::uuid,
            ${order.order_id}::uuid,'earn',${Number(order.units)}::integer,'Jumbo Thin Pizza Loyalty',
            'system-backfill',${JSON.stringify({quantity:Number(order.units),reason:"Program activation"})}::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM ordering_loyalty_ledger existing
            WHERE existing.program_id=${String(loyaltyProgram.id)} AND existing.order_id=${order.order_id} AND existing.entry_type='earn'
          ) ON CONFLICT DO NOTHING
        `;
      }
    }
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

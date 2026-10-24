import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { addConfiguredItem, recalculateOrder, type ConfiguredOrderItemInput } from "@/lib/ordering-orders";
import { resolveItemVariantPricing } from "@/lib/ordering-variant-pricing";
import { pizzaToppingPriceCents, type PizzaToppingAmount, type PizzaToppingPortion } from "@/lib/ordering-pizza-toppings";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

export class TabConflictError extends Error {}

export async function listOpenTikiTabs() {
  await ensureOrderingPosSchema();
  const sql = getSql();
  return sql`
    SELECT o.id,o.display_number,o.status,o.payment_status,o.total_cents,o.paid_cents,o.amount_due_cents,
      o.first_name_snapshot tab_name,o.created_at,o.updated_at,
      COALESCE((SELECT SUM(quantity)::integer FROM ordering_order_items WHERE order_id=o.id),0) item_count
    FROM ordering_orders o
    WHERE o.business='Tiki' AND o.service_type='bar' AND o.status='draft' AND o.payment_status NOT IN ('paid','refunded')
    ORDER BY o.updated_at ASC,o.created_at ASC
  `;
}

export async function getTikiTab(id: string) {
  await ensureOrderingPosSchema();
  const sql = getSql();
  const rows = await sql`SELECT * FROM ordering_orders WHERE id=${id} AND business='Tiki' AND service_type='bar' LIMIT 1`;
  if (!rows[0]) return null;
  const order = rows[0];
  order.items = await sql`SELECT id,item_id,item_name_snapshot,variant_name_snapshot,quantity,line_total_cents,special_instructions FROM ordering_order_items WHERE order_id=${id} ORDER BY sort_order,created_at,id`;
  return order;
}

type TabItemInput=ConfiguredOrderItemInput&{variantId?:string|null};
async function applyVariant(orderItemId:string,item:TabItemInput){const sql=getSql();const row=(await sql`SELECT item_id,quantity,combo_total_cents FROM ordering_order_items WHERE id=${orderItemId}`)[0];const variant=await resolveItemVariantPricing({business:"Tiki",itemId:String(row.item_id),variantId:item.variantId||null});await sql`UPDATE ordering_order_items SET variant_id=${variant.variantId},variant_name_snapshot=${variant.variantName},variant_sku_snapshot=${variant.variantSku},unit_price_cents=${variant.basePriceCents},updated_at=NOW() WHERE id=${orderItemId}`;const modifiers=await sql`SELECT id,option_id,selection_state,pizza_topping_portion,pizza_topping_amount FROM ordering_order_item_modifiers WHERE order_item_id=${orderItemId}`;for(const modifier of modifiers){if(modifier.selection_state!=="selected"&&modifier.selection_state!=="extra")continue;const override=variant.modifierPrices.get(String(modifier.option_id));if(!override)continue;if(!override.available)throw new TabConflictError("A selected modifier is not available for the chosen size or form.");const charged=modifier.pizza_topping_portion&&modifier.pizza_topping_amount?pizzaToppingPriceCents(override.priceDeltaCents,modifier.pizza_topping_portion as PizzaToppingPortion,modifier.pizza_topping_amount as PizzaToppingAmount):override.priceDeltaCents;await sql`UPDATE ordering_order_item_modifiers SET unit_price_delta_cents=${charged} WHERE id=${modifier.id}`;}await sql`UPDATE ordering_order_items item SET modifier_total_cents=totals.modifier_total_cents,line_total_cents=GREATEST(0,item.quantity*(item.unit_price_cents+totals.modifier_total_cents+item.combo_total_cents)),updated_at=NOW() FROM (SELECT COALESCE(SUM(CASE WHEN selection_state IN ('selected','extra') THEN unit_price_delta_cents*quantity ELSE 0 END),0)::integer modifier_total_cents FROM ordering_order_item_modifiers WHERE order_item_id=${orderItemId}) totals WHERE item.id=${orderItemId}`}

export async function appendTikiTabItems(input: { orderId: string; items: TabItemInput[]; actor: OrderingActor }) {
  await ensureOrderingPosSchema();
  if (!input.items.length) throw new TabConflictError("Add at least one item to the tab.");
  return withTransaction(async () => {
    const sql = getSql();
    const rows = await sql`SELECT * FROM ordering_orders WHERE id=${input.orderId} AND business='Tiki' AND service_type='bar' FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new TabConflictError("Tiki tab was not found.");
    if (order.status !== "draft") throw new TabConflictError("Only an open tab can accept more items.");
    if (order.payment_status === "paid" || order.payment_status === "refunded") throw new TabConflictError("A closed tab cannot accept more items.");
    if (Number(order.paid_cents) > 0) throw new TabConflictError("Add items before taking payment on a tab.");
    for (const item of input.items){const orderItemId=await addConfiguredItem(input.orderId,"Tiki",item);await applyVariant(orderItemId,item)}
    await recalculateOrder(input.orderId);
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)
      SELECT ${randomUUID()},id,version,'tab_items_added',${input.actor.type},${input.actor.id},${JSON.stringify({ itemCount: input.items.length, actorName: input.actor.name })}::jsonb FROM ordering_orders WHERE id=${input.orderId}`;
    return getTikiTab(input.orderId);
  });
}

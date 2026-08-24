import { getSql } from "@/lib/db";
import type { OrderingBusiness, OrderSource, ServiceType } from "@/lib/ordering-core";
import { addConfiguredItem, createDraftOrder, recalculateOrder, type ConfiguredOrderItemInput } from "@/lib/ordering-orders";
import { resolveItemVariantPricing } from "@/lib/ordering-variant-pricing";
import { pizzaToppingPriceCents, type PizzaToppingAmount, type PizzaToppingPortion } from "@/lib/ordering-pizza-toppings";

export type VariantConfiguredOrderItemInput = ConfiguredOrderItemInput & {
  variantId?: string | null;
};

export type CreateVariantDraftOrderInput = {
  business: OrderingBusiness;
  source: OrderSource;
  serviceType: ServiceType;
  customerId?: string | null;
  customerPhoneId?: string | null;
  callerPhone?: string;
  customerFirstName?: string;
  customerLastName?: string;
  orderOrigin?: "pos"|"phone"|"web"|"ai";
  createdBy: string;
  createdByName?: string;
  items?: VariantConfiguredOrderItemInput[];
};

type OrderItemRow = {
  id: string;
  item_id: string;
  quantity: number;
  combo_total_cents: number;
};
type ModifierRow = { id: string; option_id: string; selection_state: string; unit_price_delta_cents: number; pizza_topping_portion: PizzaToppingPortion | null; pizza_topping_amount: PizzaToppingAmount | null };

async function applyVariantPricing(orderId:string,business:OrderingBusiness,items:VariantConfiguredOrderItemInput[],orderItemIds?:string[]) {
  const sql=getSql();
  const orderItems = (orderItemIds?.length
    ? await sql`SELECT id,item_id,quantity,combo_total_cents FROM ordering_order_items WHERE order_id=${orderId} AND id=ANY(${orderItemIds}) ORDER BY sort_order,created_at,id`
    : await sql`SELECT id,item_id,quantity,combo_total_cents FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`) as OrderItemRow[];
  if (orderItems.length !== items.length) throw new Error("Draft order item count changed while applying size pricing.");
  for (let index = 0; index < items.length; index += 1) {
    const requestItem=items[index],row=orderItems[index];
    if(row.item_id!==requestItem.itemId)throw new Error("Draft order item order changed while applying size pricing.");
    const variant=await resolveItemVariantPricing({business,itemId:row.item_id,variantId:requestItem.variantId||null});
    await sql`UPDATE ordering_order_items SET variant_id=${variant.variantId},variant_name_snapshot=${variant.variantName},variant_sku_snapshot=${variant.variantSku},unit_price_cents=${variant.basePriceCents},updated_at=NOW() WHERE id=${row.id}`;
    const modifiers=(await sql`SELECT id,option_id,selection_state,unit_price_delta_cents,pizza_topping_portion,pizza_topping_amount FROM ordering_order_item_modifiers WHERE order_item_id=${row.id}`) as ModifierRow[];
    for(const modifier of modifiers){
      if(modifier.selection_state!=="selected"&&modifier.selection_state!=="extra")continue;
      const override=variant.modifierPrices.get(modifier.option_id);if(!override)continue;
      if(!override.available)throw new Error("A selected modifier is not available for the chosen size or form.");
      const charged=modifier.pizza_topping_portion&&modifier.pizza_topping_amount?pizzaToppingPriceCents(override.priceDeltaCents,modifier.pizza_topping_portion,modifier.pizza_topping_amount):override.priceDeltaCents;
      await sql`UPDATE ordering_order_item_modifiers SET unit_price_delta_cents=${charged} WHERE id=${modifier.id}`;
    }
    await sql`UPDATE ordering_order_items item SET modifier_total_cents=totals.modifier_total_cents,line_total_cents=GREATEST(0,item.quantity*(item.unit_price_cents+totals.modifier_total_cents+item.combo_total_cents)),updated_at=NOW() FROM(SELECT COALESCE(SUM(CASE WHEN selection_state IN('selected','extra')THEN unit_price_delta_cents*quantity ELSE 0 END),0)::INTEGER modifier_total_cents FROM ordering_order_item_modifiers WHERE order_item_id=${row.id})totals WHERE item.id=${row.id}`;
  }
  await recalculateOrder(orderId);
}

export async function appendConfiguredOrderItemsWithVariants(orderId:string,business:OrderingBusiness,items:VariantConfiguredOrderItemInput[]){
  const ids:string[]=[];
  try {
    for(const item of items)ids.push(await addConfiguredItem(orderId,business,item));
    await applyVariantPricing(orderId,business,items,ids);
    return ids;
  } catch(error) {
    if(ids.length)await getSql()`DELETE FROM ordering_order_items WHERE id=ANY(${ids})`;
    await recalculateOrder(orderId);
    throw error;
  }
}

/**
 * Uses the existing validated draft-order writer, then deterministically applies
 * size/form pricing to the persisted lines. This keeps variant pricing shared by
 * POS/web/AI without forking the modifier/combo validation already in use.
 */
export async function createDraftOrderWithVariants(input: CreateVariantDraftOrderInput) {
  const items = input.items || [];
  const order = await createDraftOrder({
    ...input,
    items: items.map(({ variantId: _variantId, ...item }) => item),
  });

  const sql = getSql();
  try {
    const orderItems = (await sql`
      SELECT id, item_id, quantity, combo_total_cents
      FROM ordering_order_items
      WHERE order_id = ${order.id}
      ORDER BY sort_order, created_at, id
    `) as OrderItemRow[];
    if (orderItems.length !== items.length) throw new Error("Draft order item count changed while applying size pricing.");

    for (let index = 0; index < items.length; index += 1) {
      const requestItem = items[index];
      const row = orderItems[index];
      if (row.item_id !== requestItem.itemId) throw new Error("Draft order item order changed while applying size pricing.");

      const variant = await resolveItemVariantPricing({
        business: input.business,
        itemId: row.item_id,
        variantId: requestItem.variantId || null,
      });

      await sql`
        UPDATE ordering_order_items
        SET variant_id = ${variant.variantId},
            variant_name_snapshot = ${variant.variantName},
            variant_sku_snapshot = ${variant.variantSku},
            unit_price_cents = ${variant.basePriceCents},
            updated_at = NOW()
        WHERE id = ${row.id}
      `;

      const modifiers = (await sql`
        SELECT id, option_id, selection_state, unit_price_delta_cents, pizza_topping_portion, pizza_topping_amount
        FROM ordering_order_item_modifiers
        WHERE order_item_id = ${row.id}
      `) as ModifierRow[];
      for (const modifier of modifiers) {
        if (modifier.selection_state !== "selected" && modifier.selection_state !== "extra") continue;
        const override = variant.modifierPrices.get(modifier.option_id);
        if (!override) continue;
        if (!override.available) throw new Error("A selected modifier is not available for the chosen size or form.");
        const charged = modifier.pizza_topping_portion && modifier.pizza_topping_amount
          ? pizzaToppingPriceCents(override.priceDeltaCents, modifier.pizza_topping_portion, modifier.pizza_topping_amount)
          : override.priceDeltaCents;
        await sql`
          UPDATE ordering_order_item_modifiers
          SET unit_price_delta_cents = ${charged}
          WHERE id = ${modifier.id}
        `;
      }

      await sql`
        UPDATE ordering_order_items item
        SET modifier_total_cents = totals.modifier_total_cents,
            line_total_cents = GREATEST(0,
              item.quantity * (item.unit_price_cents + totals.modifier_total_cents + item.combo_total_cents)
            ),
            updated_at = NOW()
        FROM (
          SELECT COALESCE(SUM(
            CASE WHEN selection_state IN ('selected', 'extra') THEN unit_price_delta_cents * quantity ELSE 0 END
          ), 0)::INTEGER AS modifier_total_cents
          FROM ordering_order_item_modifiers
          WHERE order_item_id = ${row.id}
        ) totals
        WHERE item.id = ${row.id}
      `;
    }

    await sql`
      UPDATE ordering_orders ordering_order
      SET subtotal_cents = totals.subtotal_cents,
          total_cents = GREATEST(0, totals.subtotal_cents - discount_cents + tax_cents + tip_cents),
          amount_due_cents = GREATEST(0, totals.subtotal_cents - discount_cents + tax_cents + tip_cents - paid_cents),
          version = version + 1,
          updated_at = NOW()
      FROM (
        SELECT COALESCE(SUM(line_total_cents), 0)::INTEGER AS subtotal_cents
        FROM ordering_order_items
        WHERE order_id = ${order.id}
      ) totals
      WHERE ordering_order.id = ${order.id}
    `;

    const rows = await sql`
      SELECT id, business, display_number, status, payment_status, service_type, version,
             subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, paid_cents,
             amount_due_cents, created_at, updated_at
      FROM ordering_orders
      WHERE id = ${order.id}
      LIMIT 1
    `;
    return rows[0];
  } catch (error) {
    // Drafts are not externally committed yet. Remove the draft if variant
    // validation fails so no half-priced or ambiguous line can linger.
    await sql`DELETE FROM ordering_orders WHERE id = ${order.id}`;
    throw error;
  }
}

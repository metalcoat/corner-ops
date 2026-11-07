import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { recalculateOrder } from "@/lib/ordering-orders";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import type { CustomItemInput } from "@/lib/custom-item-rules";

const LABEL = "Custom item";

/** The hidden menu entry custom lines hang off; inactive, so it never shows on a menu. */
async function customMenuItemId(business: OrderingBusiness) {
  const sql = getSql(), existing = (await sql`SELECT item.id FROM ordering_menu_items item JOIN ordering_menu_categories category ON category.id=item.category_id WHERE item.business=${business} AND category.name=${LABEL} AND item.name=${LABEL} LIMIT 1`)[0];
  if (existing) return String(existing.id);
  const category = (await sql`INSERT INTO ordering_menu_categories(id,business,name,sort_order,active) VALUES(${randomUUID()},${business},${LABEL},9999,FALSE) RETURNING id`)[0];
  return String((await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,description,sku,base_price_cents,taxable,available,active,sort_order) VALUES(${randomUUID()},${business},${category.id},${LABEL},'',${"CUSTOM-ITEM"},0,TRUE,TRUE,FALSE,9999) RETURNING id`)[0].id);
}

export async function appendCustomOrderItems(orderId: string, business: OrderingBusiness, items: CustomItemInput[], actor: OrderingActor) {
  if (!items.length) return [];
  const sql = getSql(), itemId = await customMenuItemId(business), ids: string[] = [];
  let sort = Number((await sql`SELECT COALESCE(MAX(sort_order),0)::int last FROM ordering_order_items WHERE order_id=${orderId}`)[0].last);
  for (const item of items) {
    const id = randomUUID();
    await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,item_print_name_snapshot,quantity,unit_price_cents,line_total_cents,special_instructions,sort_order,category_name_snapshot,custom_item,added_by,added_by_name)
      VALUES(${id},${orderId},${itemId},${item.name},${item.name},${item.quantity},${item.priceCents},${item.priceCents * item.quantity},${item.note},${++sort},${LABEL},TRUE,${actor.id},${actor.name})`;
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'custom_item_added',${actor.type},${actor.id},${JSON.stringify({ itemId: id, name: item.name, priceCents: item.priceCents, quantity: item.quantity, actorName: actor.name })}::jsonb FROM ordering_orders WHERE id=${orderId}`;
    ids.push(id);
  }
  await recalculateOrder(orderId);
  return ids;
}

import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingInventorySchema } from "@/lib/ordering-inventory-schema";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { createDraftOrder, type ConfiguredOrderItemInput } from "@/lib/ordering-orders";
import { submitDraftOrder } from "@/lib/ordering-order-lifecycle";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { ensureWorkforceSchema } from "@/lib/workforce";

let schemaPromise: Promise<void> | null = null;
export async function ensureEmployeeMealSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await Promise.all([ensureOrderingInventorySchema(), ensureOrderingTimingSchema()]);
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_employee_meals(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),employee_id UUID NOT NULL REFERENCES employees(id),employee_name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_employee_meals_employee_idx ON ordering_employee_meals(employee_id,created_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_employee_meal_lines(id UUID PRIMARY KEY,meal_id UUID NOT NULL REFERENCES ordering_employee_meals(id) ON DELETE CASCADE,menu_item_id UUID NOT NULL REFERENCES ordering_menu_items(id),item_name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

export async function recordEmployeeMeal(input:{business:"Corner Deli";items:ConfiguredOrderItemInput[];note:string;breakAcknowledged:boolean;actor:OrderingActor}) {
  await ensureEmployeeMealSchema();
  await ensureWorkforceSchema();
  if (!input.breakAcknowledged) throw new Error("Confirm that this meal will only be eaten during a break, not while working.");
  if (input.items.length !== 1 || Number(input.items[0]?.quantity || 1) !== 1) throw new Error("Employee meals are limited to one entrée or one combo. Drinks and extra items are not included.");
  const sql=getSql(),employee=(await sql`SELECT id FROM employees WHERE id=${input.actor.id} AND business=${input.business} AND active=TRUE`)[0];
  if(!employee)throw new Error("The signed-in employee was not found.");
  const scheduled=(await sql`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at-starts_at))),0) seconds FROM schedule_shifts WHERE business=${input.business} AND employee_id=${input.actor.id} AND status='Published' AND (starts_at AT TIME ZONE 'America/New_York')::date=(NOW() AT TIME ZONE 'America/New_York')::date`)[0];
  if(Number(scheduled?.seconds||0)<21600)throw new Error("Employee meals require a published shift totaling at least 6 hours today.");
  const already=(await sql`SELECT id FROM ordering_employee_meals WHERE business=${input.business} AND employee_id=${input.actor.id} AND (created_at AT TIME ZONE 'America/New_York')::date=(NOW() AT TIME ZONE 'America/New_York')::date LIMIT 1`)[0];
  if(already)throw new Error("An employee meal has already been recorded for this employee today.");
  const order=await createDraftOrder({business:input.business,source:"pos",serviceType:"dine_in",customerFirstName:input.actor.name,orderOrigin:"pos",createdBy:input.actor.id,createdByName:input.actor.name,items:input.items});
  try {
    const priced=(await sql`SELECT item.id,item.item_id,item.item_name_snapshot,item.variant_name_snapshot,item.quantity,item.line_total_cents,COALESCE(category.display_name,category.name,'') category_name FROM ordering_order_items item JOIN ordering_menu_items menu ON menu.id=item.item_id LEFT JOIN ordering_menu_categories category ON category.id=menu.category_id WHERE item.order_id=${order.id}`)[0];
    if(!priced)throw new Error("Choose one employee meal item.");
    const label=`${priced.item_name_snapshot} ${priced.variant_name_snapshot||""} ${priced.category_name||""}`.toLowerCase();
    if(/drink|beverage|soda|pepsi|coke|mountain dew|coffee|tea|water/.test(label))throw new Error("Drinks are not included with an employee meal.");
    const customerPriceCents=Number(priced.line_total_cents),employeeOwesCents=Math.max(0,customerPriceCents-1000);
    if(/wing/.test(label)){const counts=[...label.matchAll(/\b(\d{1,2})\b/g)].map(match=>Number(match[1]));if(!counts.length||Math.max(...counts)>8)throw new Error("Employee meals are limited to 8 wings.");}
    const mealId=randomUUID(),unmappedItems:string[]=[];
    await withTransaction(async()=>{await sql`INSERT INTO ordering_employee_meals(id,business,employee_id,employee_name,note) VALUES(${mealId},${input.business},${input.actor.id},${input.actor.name},${input.note.trim().slice(0,500)})`;await sql`INSERT INTO ordering_employee_meal_lines(id,meal_id,menu_item_id,item_name,quantity) VALUES(${randomUUID()},${mealId},${priced.item_id},${priced.item_name_snapshot},1)`;const links=await sql`SELECT link.*,inventory.estimated_unit_cost_cents FROM ordering_menu_inventory_links link JOIN ordering_inventory_items inventory ON inventory.id=link.inventory_item_id AND inventory.active=TRUE WHERE link.business=${input.business} AND link.menu_item_id=${priced.item_id} AND link.active=TRUE`;if(!links.length)unmappedItems.push(String(priced.item_name_snapshot));for(const link of links){const location=(await sql`SELECT location_id FROM ordering_inventory_item_locations WHERE inventory_item_id=${link.inventory_item_id} AND active=TRUE ORDER BY is_default DESC,created_at LIMIT 1`)[0];await sql`INSERT INTO ordering_inventory_movements(id,business,inventory_item_id,location_id,delta_quantity,unit,reason,employee_id,estimated_unit_cost_cents,note,source,created_by,details) VALUES(${randomUUID()},${input.business},${link.inventory_item_id},${location?.location_id||null},${-Number(link.quantity_used)},${link.unit},'employee_meal',${input.actor.id},${link.estimated_unit_cost_cents},${`Employee meal: ${priced.item_name_snapshot}`},'pos',${input.actor.id},${JSON.stringify({mealId,orderId:order.id,menuItemId:priced.item_id})}::jsonb)`;}await sql`UPDATE ordering_orders SET order_origin='employee_meal',special_instructions=${`EMPLOYEE MEAL · ${input.actor.name} · BREAK ONLY\n${input.note.trim()}`.trim()},updated_at=NOW() WHERE id=${order.id}`;});
    await submitDraftOrder(String(order.id),input.business,input.actor);
    await sql`UPDATE ordering_orders SET discount_cents=GREATEST(0,subtotal_cents+tax_cents-${employeeOwesCents}),total_cents=${employeeOwesCents},paid_cents=0,amount_due_cents=${employeeOwesCents},payment_status=${employeeOwesCents>0?'unpaid':'paid'},updated_at=NOW() WHERE id=${order.id}`;
    await sql`UPDATE ordering_print_jobs SET payload=jsonb_set(jsonb_set(payload,'{heading}',to_jsonb('EMPLOYEE MEAL'::text)),'{paymentLabel}',to_jsonb(${employeeOwesCents>0?`EMPLOYEE OWES $${(employeeOwesCents/100).toFixed(2)} · BREAK ONLY`:'NO CHARGE · BREAK ONLY'}::text)) WHERE order_id=${order.id} AND purpose='kitchen_production'`;
    await sql`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details) VALUES(${randomUUID()},${input.business},${input.actor.id},${input.actor.role||"employee"},'employee_meal_recorded','employee_meal',${mealId},'',${JSON.stringify({employeeName:input.actor.name,orderId:order.id,customerPriceCents,employeeMealCreditCents:Math.min(1000,customerPriceCents),employeeOwesCents,unmappedItems})}::jsonb)`;
    await dispatchSubmittedOrderPrintJobs(String(order.id),input.business);
    return{mealId,orderId:order.id,displayNumber:order.display_number,employeeName:input.actor.name,customerPriceCents,employeeMealCreditCents:Math.min(1000,customerPriceCents),employeeOwesCents,unmappedItems};
  } catch(error) { await sql`DELETE FROM ordering_orders WHERE id=${order.id} AND status='draft'`; throw error; }
}

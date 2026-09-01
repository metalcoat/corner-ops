import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingInventorySchema } from "@/lib/ordering-inventory-schema";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";
import type { OrderingActor } from "@/lib/ordering-route-auth";

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

export async function recordEmployeeMeal(input:{business:"Corner Deli";lines:Array<{itemId:string;quantity:number}>;note:string;actor:OrderingActor}) {
  await ensureEmployeeMealSchema();
  if (!input.lines.length) throw new Error("Choose at least one meal item.");
  return withTransaction(async()=>{const sql=getSql(),mealId=randomUUID(),unmappedItems:string[]=[];const employee=(await sql`SELECT id FROM employees WHERE id=${input.actor.id} AND business=${input.business} AND active=TRUE`)[0];if(!employee)throw new Error("The signed-in employee was not found.");await sql`INSERT INTO ordering_employee_meals(id,business,employee_id,employee_name,note) VALUES(${mealId},${input.business},${input.actor.id},${input.actor.name},${input.note.trim().slice(0,500)})`;for(const requested of input.lines){if(!Number.isSafeInteger(requested.quantity)||requested.quantity<1||requested.quantity>25)throw new Error("Meal quantities must be between 1 and 25.");const item=(await sql`SELECT id,name FROM ordering_menu_items WHERE id=${requested.itemId} AND business=${input.business} AND active=TRUE`)[0];if(!item)throw new Error("A selected meal item is no longer available.");await sql`INSERT INTO ordering_employee_meal_lines(id,meal_id,menu_item_id,item_name,quantity) VALUES(${randomUUID()},${mealId},${item.id},${item.name},${requested.quantity})`;const links=await sql`SELECT link.*,inventory.estimated_unit_cost_cents FROM ordering_menu_inventory_links link JOIN ordering_inventory_items inventory ON inventory.id=link.inventory_item_id AND inventory.active=TRUE WHERE link.business=${input.business} AND link.menu_item_id=${item.id} AND link.active=TRUE`;if(!links.length)unmappedItems.push(String(item.name));for(const link of links){const location=(await sql`SELECT location_id FROM ordering_inventory_item_locations WHERE inventory_item_id=${link.inventory_item_id} AND active=TRUE ORDER BY is_default DESC,created_at LIMIT 1`)[0];await sql`INSERT INTO ordering_inventory_movements(id,business,inventory_item_id,location_id,delta_quantity,unit,reason,employee_id,estimated_unit_cost_cents,note,source,created_by,details) VALUES(${randomUUID()},${input.business},${link.inventory_item_id},${location?.location_id||null},${-Number(link.quantity_used)*requested.quantity},${link.unit},'employee_meal',${input.actor.id},${link.estimated_unit_cost_cents},${`Employee meal: ${item.name}`},'pos',${input.actor.id},${JSON.stringify({mealId,menuItemId:item.id,itemName:item.name,mealQuantity:requested.quantity})}::jsonb)`;}}await sql`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details) VALUES(${randomUUID()},${input.business},${input.actor.id},${input.actor.role||"employee"},'employee_meal_recorded','employee_meal',${mealId},'',${JSON.stringify({employeeName:input.actor.name,lines:input.lines,unmappedItems})}::jsonb)`;return{mealId,employeeName:input.actor.name,unmappedItems};});
}

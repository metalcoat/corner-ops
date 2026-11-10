import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.VALIDATION_DATABASE_URL || process.env.ORDERING_AUDIT_DATABASE !== "1") throw new Error("An explicitly isolated audit database is required.");
process.env.DATABASE_URL = process.env.VALIDATION_DATABASE_URL;
process.env.DATABASE_DRIVER = "postgres";
process.env.VALIDATION_DISABLE_OUTBOUND = "1";

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { recordEmployeeMeal, employeeMealEligibility } = await import("../src/lib/ordering-employee-meals");
  const sql = getSql();
  const employeeId=randomUUID(), categoryId=randomUUID(), itemId=randomUUID(), smallId=randomUUID(), largeId=randomUUID(), inventoryId=randomUUID(), shiftId=randomUUID();
  const actor={id:employeeId,name:"Audit Meal",type:"employee" as const,role:"manager" as const};
  const [{business_date:businessDate}] = await sql`SELECT (NOW() AT TIME ZONE COALESCE((SELECT timezone FROM ordering_business_ordering_settings WHERE business='Corner Deli'),'America/New_York'))::date::text business_date`;
  const previousHours=await sql`SELECT * FROM ordering_special_hours WHERE business='Corner Deli' AND service_type='dine_in' AND business_date=${businessDate}::date`;
  const previousPrinting=await sql`SELECT * FROM ordering_external_print_settings WHERE business='Corner Deli'`;
  try {
    await sql`INSERT INTO ordering_external_print_settings(business,auto_print_enabled) VALUES('Corner Deli',FALSE) ON CONFLICT(business) DO UPDATE SET auto_print_enabled=FALSE`;
    await sql`INSERT INTO ordering_special_hours(id,business,business_date,service_type,status,opens_at,closes_at) VALUES(${randomUUID()},'Corner Deli',${businessDate}::date,'dine_in','custom_hours','00:00','23:59') ON CONFLICT(business,business_date,service_type) DO UPDATE SET status='custom_hours',opens_at='00:00',closes_at='23:59',ordering_opens_at=NULL,ordering_cutoff_at=NULL`;
    await sql`INSERT INTO employees(id,business,name,pin_hash) VALUES(${employeeId},'Corner Deli','Audit Meal','audit-invalid-hash')`;
    await sql`INSERT INTO schedule_shifts(id,business,employee_id,starts_at,ends_at,status,created_by) VALUES(${shiftId},'Corner Deli',${employeeId},date_trunc('day',NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York',(date_trunc('day',NOW() AT TIME ZONE 'America/New_York')+INTERVAL '8 hours') AT TIME ZONE 'America/New_York','Published','audit')`;
    await sql`INSERT INTO ordering_menu_categories(id,business,name) VALUES(${categoryId},'Corner Deli',${`Audit Meals ${categoryId}`})`;
    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) VALUES(${itemId},'Corner Deli',${categoryId},'Audit Pizza',500)`;
    await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents) VALUES(${smallId},${itemId},'Small',500),(${largeId},${itemId},'Large',2000)`;
    await sql`INSERT INTO ordering_inventory_items(id,business,name) VALUES(${inventoryId},'Corner Deli',${`Audit Meal Inventory ${inventoryId}`})`;
    await sql`INSERT INTO ordering_menu_inventory_links(id,business,menu_item_id,inventory_item_id,quantity_used,unit) VALUES(${randomUUID()},'Corner Deli',${itemId},${inventoryId},1,'each')`;
    const input={business:"Corner Deli" as const,items:[{itemId,variantId:largeId,quantity:1}],note:"Isolated meal audit",breakAcknowledged:true,actor};
    await assert.rejects(()=>recordEmployeeMeal({...input,items:[{itemId,quantity:1}]}),/Choose a size/);
    await assert.rejects(()=>recordEmployeeMeal({...input,actor:{...actor,name:""}}),/Customer name is required/);
    assert.equal((await employeeMealEligibility({business:"Corner Deli",actor})).eligible,true);
    assert.equal(Number((await sql`SELECT COUNT(*) count FROM ordering_employee_meals WHERE employee_id=${employeeId}`)[0].count),0);
    assert.equal(Number((await sql`SELECT COUNT(*) count FROM ordering_inventory_movements WHERE inventory_item_id=${inventoryId}`)[0].count),0);
    assert.equal(Number((await sql`SELECT COUNT(*) count FROM ordering_orders WHERE created_by=${employeeId}`)[0].count),0);
    const attempts=await Promise.allSettled([recordEmployeeMeal(input),recordEmployeeMeal(input)]);
    assert.equal(attempts.filter((attempt)=>attempt.status==='fulfilled').length,1);
    const result=attempts.find((attempt)=>attempt.status==='fulfilled');
    assert.ok(result?.status==='fulfilled');
    assert.equal(result.value.customerPriceCents,2000);
    assert.equal(result.value.employeeOwesCents,1000);
    const [line]=await sql`SELECT variant_id,variant_name_snapshot,unit_price_cents FROM ordering_order_items WHERE order_id=${result.value.orderId}`;
    assert.equal(line.variant_id,largeId); assert.equal(line.variant_name_snapshot,'Large'); assert.equal(line.unit_price_cents,2000);
    const movements=await sql`SELECT delta_quantity,source,details FROM ordering_inventory_movements WHERE inventory_item_id=${inventoryId}`;
    assert.equal(movements.length,1); assert.equal(Number(movements[0].delta_quantity),-1); assert.equal(movements[0].source,'employee_meal');
    assert.match((await employeeMealEligibility({business:"Corner Deli",actor})).error,/already been recorded/);
    // Without a published 6-hour shift the reason must name the shift rule, not a used meal; the POS shows this text as-is.
    await sql`UPDATE schedule_shifts SET status='Draft' WHERE id=${shiftId}`;
    const noShift=await employeeMealEligibility({business:"Corner Deli",actor});
    assert.equal(noShift.eligible,false); assert.match(noShift.error,/published shift/); assert.doesNotMatch(noShift.error,/already/);
    console.log(JSON.stringify({noShiftReasonIsShiftRule:true,variantPriceAndSizePreserved:true,failedSubmissionRollsBackMealAndInventory:true,concurrentMealLimit:true,singleStockDepletion:true}));
  } finally {
    await sql`DELETE FROM ordering_inventory_movements WHERE inventory_item_id=${inventoryId}`;
    await sql`DELETE FROM ordering_print_jobs WHERE order_id IN(SELECT id FROM ordering_orders WHERE created_by=${employeeId})`;
    await sql`DELETE FROM ordering_orders WHERE created_by=${employeeId}`;
    await sql`DELETE FROM ordering_employee_meals WHERE employee_id=${employeeId}`;
    await sql`DELETE FROM ordering_operations_audit WHERE actor_id=${employeeId}`;
    await sql`DELETE FROM ordering_menu_items WHERE id=${itemId}`;
    await sql`DELETE FROM ordering_menu_categories WHERE id=${categoryId}`;
    await sql`DELETE FROM ordering_inventory_items WHERE id=${inventoryId}`;
    await sql`DELETE FROM schedule_shifts WHERE id=${shiftId}`;
    await sql`DELETE FROM employees WHERE id=${employeeId}`;
    await sql`DELETE FROM ordering_special_hours WHERE business='Corner Deli' AND service_type='dine_in' AND business_date=${businessDate}::date`;
    if(previousHours[0]) await sql`INSERT INTO ordering_special_hours SELECT * FROM jsonb_populate_record(NULL::ordering_special_hours,${JSON.stringify(previousHours[0])}::jsonb)`;
    await sql`DELETE FROM ordering_external_print_settings WHERE business='Corner Deli'`;
    if(previousPrinting[0]) await sql`INSERT INTO ordering_external_print_settings SELECT * FROM jsonb_populate_record(NULL::ordering_external_print_settings,${JSON.stringify(previousPrinting[0])}::jsonb)`;
  }
}
main().then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1)});

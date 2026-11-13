#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main() {
  if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true")
    throw new Error("Driver cash fixtures are restricted to local development.");
  const [{ getSql, withTransaction }, { ensureDriverDeliverySchema }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ordering-driver-delivery"),
  ]);
  await ensureDriverDeliverySchema();
  const created = await withTransaction(async () => {
    const sql = getSql();
    let driver = (await sql`SELECT id,name FROM employees WHERE business='Corner Deli' AND name='POS Test Driver' AND active=TRUE LIMIT 1`)[0];
    if (!driver) {
      const id = randomUUID();
      driver = (await sql`INSERT INTO employees(id,business,name,pin_hash,position,role_group,counts_for_tips,active,pin_enabled,pos_role) VALUES(${id},'Corner Deli','POS Test Driver',${createHash("sha256").update(randomUUID()).digest("hex")},'Test Driver','Driver',FALSE,TRUE,FALSE,'employee') RETURNING id,name`)[0];
    }
    const item = (await sql`SELECT id,name FROM ordering_menu_items WHERE business='Corner Deli' AND active=TRUE ORDER BY name LIMIT 1`)[0];
    if (!item) throw new Error("A Corner Deli menu item is required for fixtures.");
    const stamp = Date.now().toString().slice(-6), rows: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= 5; index++) {
      const orderId = randomUUID(), total = 1600 + index * 300, display = `TEST-CASH-${stamp}-${index}`;
      await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,subtotal_cents,total_cents,paid_cents,amount_due_cents,submitted_at,ready_at,completed_at,closed_at,special_instructions) VALUES(${orderId},'Corner Deli','pos','completed','unpaid','delivery',${display},'driver-cash-fixture','Bulk Cash',${`Test ${index}`},${`31555501${String(index).padStart(2,"0")}`},${total},${total},0,${total},NOW()-INTERVAL '90 minutes',NOW()-INTERVAL '60 minutes',NOW()-INTERVAL '30 minutes',NOW()-INTERVAL '30 minutes','LOCAL TEST ORDER — driver bulk cash-out')`;
      await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents,sort_order) VALUES(${randomUUID()},${orderId},${item.id},${item.name},1,${total},${total},0)`;
      await sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at,route_distance_miles,route_duration_seconds,route_provider,route_calculated_at,delivery_notes_snapshot) VALUES(${orderId},${`${100 + index} Test Lane, Ogdensburg, NY 13669`},${`${100 + index} Test Lane, Ogdensburg, NY 13669`},${`${100 + index} Test Lane`},'Ogdensburg','NY','13669',44.6942,-75.4863,'fixture','validated',NOW(),1.5,420,'fixture',NOW(),'LOCAL TEST ADDRESS')`;
      await sql`INSERT INTO ordering_delivery_assignments(id,order_id,business,driver_employee_id,status,cash_expected_cents,assigned_by,assigned_at,delivered_at,status_note) VALUES(${randomUUID()},${orderId},'Corner Deli',${driver.id},'DELIVERED',${total},'driver-cash-fixture',NOW()-INTERVAL '60 minutes',NOW()-INTERVAL '30 minutes','LOCAL TEST DELIVERY')`;
      rows.push({ orderId, displayNumber: display, amountDueCents: total });
    }
    return { driver, orders: rows };
  });
  console.log(JSON.stringify(created, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

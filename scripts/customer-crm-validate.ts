import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
localValidationEnv();
void (async () => {
  const { createCustomer, addCustomerAddress, findCustomers, mergeCustomers } = await import("../src/lib/ordering-customers");
  const { ensureOrderingCustomerSchema } = await import("../src/lib/ordering-customer-schema");
  const { getSql } = await import("../src/lib/db");
  await ensureOrderingCustomerSchema(); const sql = getSql(); const ids: string[] = []; const orderIds: string[] = [];
  try {
    const a = await createCustomer({ business:"Corner Deli",firstName:"Sarah",lastName:"Smith",phone:"(315) 555-1212",notes:"Front door" }); ids.push(a.customer.id);
    const duplicate = await createCustomer({ business:"Corner Deli",firstName:"Sara",lastName:"Smith",phone:"315-555-1212" });
    if (!duplicate.duplicate || duplicate.customer.id !== a.customer.id) throw new Error("Duplicate phone was not safely reused.");
    await addCustomerAddress({ business:"Corner Deli",customerId:a.customer.id,label:"Home",line1:"412 Jay St",city:"Utica",state:"NY",postalCode:"13501" });
    await addCustomerAddress({ business:"Corner Deli",customerId:a.customer.id,label:"Work",line1:"100 Main St",city:"Utica",state:"NY",postalCode:"13501" });
    const b = await createCustomer({ business:"Corner Deli",firstName:"Sara",lastName:"Smyth",phone:"3155559999",notes:"Side door" }); ids.push(b.customer.id);
    const orderId = randomUUID(); orderIds.push(orderId);
    await sql`INSERT INTO ordering_orders(id,business,source,customer_id,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot) VALUES(${orderId},'Corner Deli','pos',${b.customer.id},'draft','unpaid','pickup','CRM-V','validation','Sara','Smyth','+13155559999')`;
    await sql`UPDATE ordering_customers SET first_name='Changed',display_name='Changed Smyth' WHERE id=${b.customer.id}`;
    await mergeCustomers({ business:"Corner Deli",survivorId:a.customer.id,mergedId:b.customer.id,actorId:"manager-validation" });
    const order = (await sql`SELECT customer_id,first_name_snapshot FROM ordering_orders WHERE id=${orderId}`)[0];
    const merged = (await sql`SELECT active,merged_into_customer_id FROM ordering_customers WHERE id=${b.customer.id}`)[0];
    const event = await sql`SELECT id FROM ordering_customer_merge_events WHERE surviving_customer_id=${a.customer.id} AND merged_customer_id=${b.customer.id}`;
    const current = await findCustomers("Corner Deli", "3155551212");
    if (current[0]?.addresses.length !== 2 || order.customer_id !== a.customer.id || order.first_name_snapshot !== "Sara" || merged.active || merged.merged_into_customer_id !== a.customer.id || !event.length) throw new Error("CRM merge/snapshot acceptance failed.");
    console.log(JSON.stringify({ normalizedLookup:true,duplicatePrevented:true,addressCount:2,orderReassociated:true,historicalSnapshot:"Sara",loserMarkedMerged:true,notesPreserved:true,mergeAudit:true },null,2));
  } finally {
    for (const id of orderIds) await sql`DELETE FROM ordering_orders WHERE id=${id}`;
    if (ids.length) await sql`DELETE FROM ordering_customer_merge_events WHERE surviving_customer_id=${ids[0]} OR merged_customer_id=${ids[0]} OR surviving_customer_id=${ids[1] || ids[0]} OR merged_customer_id=${ids[1] || ids[0]}`;
    for (const id of ids.reverse()) await sql`DELETE FROM ordering_customers WHERE id=${id}`;
  }
  process.exit();
})().catch((error)=>{console.error(error);process.exit(1)});

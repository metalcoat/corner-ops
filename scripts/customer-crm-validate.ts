import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
void (async () => {
  const { createCustomer, addCustomerAddress, addCustomerPhone, findCustomers, mergeCustomers } = await import("../src/lib/ordering-customers");
  const { ensureOrderingCustomerSchema } = await import("../src/lib/ordering-customer-schema");
  const { getSql } = await import("../src/lib/db");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { saveOrderDeliveryAddress } = await import("../src/lib/ordering-address-schema");
  await ensureOrderingCustomerSchema();
  const sql = getSql();
  const ids: string[] = [];
  const orderIds: string[] = [];
  try {
    const a = await createCustomer({ business: "Corner Deli", firstName: "Sarah", lastName: "Smith", phone: "(315) 555-1212", notes: "Front door" });
    ids.push(a.customer.id);
    const duplicate = await createCustomer({ business: "Corner Deli", firstName: "Sara", lastName: "Smith", phone: "315-555-1212" });
    if (!duplicate.duplicate || duplicate.customer.id !== a.customer.id) throw new Error("Duplicate phone was not safely reused.");
    const workPhone = await addCustomerPhone({ business: "Corner Deli", customerId: a.customer.id, phone: "315-555-8899", label: "Work" });
    if (!workPhone.phone) throw new Error("Work phone was not created.");
    await addCustomerAddress({ business: "Corner Deli", customerId: a.customer.id, label: "Home", line1: "515 Caroline St", city: "Ogdensburg", state: "NY", postalCode: "13669", isPrimary: true });
    const workAddressId = await addCustomerAddress({ business: "Corner Deli", customerId: a.customer.id, label: "Work", line1: "100 Main St", city: "Ogdensburg", state: "NY", postalCode: "13669" });
    await addCustomerAddress({ business: "Corner Deli", customerId: a.customer.id, label: "Other", line1: "312 Jay St", city: "Ogdensburg", state: "NY", postalCode: "13669" });
    const selectedOrder = await createDraftOrderWithVariants({ business: "Corner Deli", source: "pos", serviceType: "delivery", customerId: a.customer.id, customerPhoneId: String(workPhone.phone.id), createdBy: "crm-contact-validation", items: [] });
    orderIds.push(String(selectedOrder.id));
    await saveOrderDeliveryAddress({ orderId: String(selectedOrder.id), customerAddressId: workAddressId, address: { enteredAddress: "100 Main St, Ogdensburg, NY 13669", formattedAddress: "100 Main St, Ogdensburg, NY 13669", line1: "100 Main St", city: "Ogdensburg", state: "NY", postalCode: "13669", country: "US", latitude: 44.6942, longitude: -75.4863, provider: "google", providerReferenceId: "crm-work", validatedAt: new Date().toISOString() } });
    await sql`UPDATE ordering_customer_phones SET display_phone='changed later' WHERE id=${workPhone.phone.id}`;
    await sql`UPDATE ordering_customer_addresses SET line1='Changed later' WHERE id=${workAddressId}`;
    const selectedSnapshots = (await sql`SELECT o.customer_phone_id,o.phone_snapshot,d.customer_address_id,d.formatted_address FROM ordering_orders o JOIN ordering_order_delivery_addresses d ON d.order_id=o.id WHERE o.id=${selectedOrder.id}`)[0];
    if (selectedSnapshots.customer_phone_id !== workPhone.phone.id || selectedSnapshots.phone_snapshot !== "+13155558899" || selectedSnapshots.customer_address_id !== workAddressId || selectedSnapshots.formatted_address !== "100 Main St, Ogdensburg, NY 13669") throw new Error("Selected phone/address snapshots were not immutable.");

    const b = await createCustomer({ business: "Corner Deli", firstName: "Sara", lastName: "Smyth", phone: "3155559999", notes: "Side door" });
    ids.push(b.customer.id);
    const blockedShared = await addCustomerPhone({ business: "Corner Deli", customerId: b.customer.id, phone: "3155551212", label: "Home" });
    if (!blockedShared.duplicate || !blockedShared.matches?.some((match) => match.customer_id === a.customer.id)) throw new Error("Shared phone did not require explicit confirmation.");
    await addCustomerPhone({ business: "Corner Deli", customerId: b.customer.id, phone: "3155551212", label: "Home", allowShared: true });
    await addCustomerAddress({ business: "Corner Deli", customerId: b.customer.id, label: "Alternate", line1: "10 Ford St", city: "Ogdensburg", state: "NY", postalCode: "13669" });

    const orderId = randomUUID();
    orderIds.push(orderId);
    await sql`INSERT INTO ordering_orders(id,business,source,customer_id,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot) VALUES(${orderId},'Corner Deli','pos',${b.customer.id},'draft','unpaid','delivery','CRM-V','validation','Sara','Smyth','+13155559999')`;
    await sql`UPDATE ordering_customers SET first_name='Changed',display_name='Changed Smyth' WHERE id=${b.customer.id}`;
    await mergeCustomers({ business: "Corner Deli", survivorId: a.customer.id, mergedId: b.customer.id, actorId: "manager-validation" });

    const order = (await sql`SELECT customer_id,first_name_snapshot,phone_snapshot FROM ordering_orders WHERE id=${orderId}`)[0];
    const merged = (await sql`SELECT active,merged_into_customer_id FROM ordering_customers WHERE id=${b.customer.id}`)[0];
    const event = await sql`SELECT field_choices FROM ordering_customer_merge_events WHERE surviving_customer_id=${a.customer.id} AND merged_customer_id=${b.customer.id}`;
    const current = await findCustomers("Corner Deli", "3155551212");
    const canonical = current.find((customer) => customer.id === a.customer.id);
    if (!canonical || canonical.phones.length !== 3 || canonical.addresses.length !== 4) throw new Error("Merged child collections were not preserved/deduplicated.");
    if (canonical.phones.filter((item: { normalized_phone: string }) => item.normalized_phone === "+13155551212").length !== 1) throw new Error("Matching normalized phones were not deduplicated during merge.");
    if (order.customer_id !== a.customer.id || order.first_name_snapshot !== "Sara" || order.phone_snapshot !== "+13155559999") throw new Error("Order association/snapshot acceptance failed.");
    if (merged.active || merged.merged_into_customer_id !== a.customer.id || !event.length) throw new Error("Customer merge/audit acceptance failed.");
    console.log(JSON.stringify({ normalizedLookup: true, duplicatePrevented: true, explicitSharedPhone: true, phoneCount: 3, initialAddressCount: 3, selectedPhoneAndAddressSnapshots: true, mergedAddressCount: 4, orderReassociated: true, historicalSnapshotsUnchanged: true, loserMarkedMerged: true, mergeAudit: true }, null, 2));
  } finally {
    for (const id of orderIds) await sql`DELETE FROM ordering_orders WHERE id=${id}`;
    if (ids.length) await sql`DELETE FROM ordering_customer_merge_events WHERE surviving_customer_id=${ids[0]} OR merged_customer_id=${ids[0]} OR surviving_customer_id=${ids[1] || ids[0]} OR merged_customer_id=${ids[1] || ids[0]}`;
    for (const id of ids.reverse()) await sql`DELETE FROM ordering_customers WHERE id=${id}`;
  }
  process.exit();
})().catch((error) => { console.error(error); process.exit(1); });

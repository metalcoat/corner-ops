import { randomInt, randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
void (async () => {
  const { createCustomer, addCustomerAddress, addCustomerPhone, findCustomers, mergeCustomers } = await import("../src/lib/ordering-customers");
  const { ensureOrderingCustomerSchema } = await import("../src/lib/ordering-customer-schema");
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { saveOrderDeliveryAddress } = await import("../src/lib/ordering-address-schema");
  await ensureOrderingCustomerSchema();
  const ROLLBACK = "rollback:customer-crm-validation";
  // Fresh 555-01xx numbers (reserved for fiction) so the run never reuses a real local customer by phone.
  const used = new Set((await getSql()`SELECT normalized_phone FROM ordering_customer_phones WHERE normalized_phone LIKE '+1%55501__'`).map((row) => String(row.normalized_phone)));
  const freshPhone = () => { for (;;) { const phone = `${randomInt(201, 990)}55501${String(randomInt(0, 100)).padStart(2, "0")}`; if (!used.has(`+1${phone}`)) { used.add(`+1${phone}`); return phone; } } };
  const [mainPhone, workNumber, otherPhone] = [freshPhone(), freshPhone(), freshPhone()];
  const dashed = (phone: string) => `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`;
  let summary = "";
  try { await withTransaction(async () => {
    const sql = getSql();
    const a = await createCustomer({ business: "Corner Deli", firstName: "Sarah", lastName: "Smith", phone: `(${mainPhone.slice(0, 3)}) ${mainPhone.slice(3, 6)}-${mainPhone.slice(6)}`, notes: "Front door" });
    const duplicate = await createCustomer({ business: "Corner Deli", firstName: "Sara", lastName: "Smith", phone: dashed(mainPhone) });
    if (!duplicate.duplicate || duplicate.customer.id !== a.customer.id) throw new Error("Duplicate phone was not safely reused.");
    const workPhone = await addCustomerPhone({ business: "Corner Deli", customerId: a.customer.id, phone: dashed(workNumber), label: "Work" });
    if (!workPhone.phone) throw new Error("Work phone was not created.");
    await addCustomerAddress({ business: "Corner Deli", customerId: a.customer.id, label: "Home", line1: "515 Caroline St", city: "Ogdensburg", state: "NY", postalCode: "13669", isPrimary: true });
    const workAddressId = await addCustomerAddress({ business: "Corner Deli", customerId: a.customer.id, label: "Work", line1: "100 Main St", city: "Ogdensburg", state: "NY", postalCode: "13669" });
    await addCustomerAddress({ business: "Corner Deli", customerId: a.customer.id, label: "Other", line1: "312 Jay St", city: "Ogdensburg", state: "NY", postalCode: "13669" });
    const selectedOrder = await createDraftOrderWithVariants({ business: "Corner Deli", source: "pos", serviceType: "delivery", customerId: a.customer.id, customerPhoneId: String(workPhone.phone.id), createdBy: "crm-contact-validation", items: [] });
    await saveOrderDeliveryAddress({ orderId: String(selectedOrder.id), customerAddressId: workAddressId, address: { enteredAddress: "100 Main St, Ogdensburg, NY 13669", formattedAddress: "100 Main St, Ogdensburg, NY 13669", line1: "100 Main St", city: "Ogdensburg", state: "NY", postalCode: "13669", country: "US", latitude: 44.6942, longitude: -75.4863, provider: "google", providerReferenceId: "crm-work", validatedAt: new Date().toISOString() } });
    await sql`UPDATE ordering_customer_phones SET display_phone='changed later' WHERE id=${workPhone.phone.id}`;
    await sql`UPDATE ordering_customer_addresses SET line1='Changed later' WHERE id=${workAddressId}`;
    const selectedSnapshots = (await sql`SELECT o.customer_phone_id,o.phone_snapshot,d.customer_address_id,d.formatted_address FROM ordering_orders o JOIN ordering_order_delivery_addresses d ON d.order_id=o.id WHERE o.id=${selectedOrder.id}`)[0];
    if (selectedSnapshots.customer_phone_id !== workPhone.phone.id || selectedSnapshots.phone_snapshot !== `+1${workNumber}` || selectedSnapshots.customer_address_id !== workAddressId || selectedSnapshots.formatted_address !== "100 Main St, Ogdensburg, NY 13669") throw new Error("Selected phone/address snapshots were not immutable.");

    const b = await createCustomer({ business: "Corner Deli", firstName: "Sara", lastName: "Smyth", phone: otherPhone, notes: "Side door" });
    const blockedShared = await addCustomerPhone({ business: "Corner Deli", customerId: b.customer.id, phone: mainPhone, label: "Home" });
    if (!blockedShared.duplicate || !blockedShared.matches?.some((match) => match.customer_id === a.customer.id)) throw new Error("Shared phone did not require explicit confirmation.");
    await addCustomerPhone({ business: "Corner Deli", customerId: b.customer.id, phone: mainPhone, label: "Home", allowShared: true });
    await addCustomerAddress({ business: "Corner Deli", customerId: b.customer.id, label: "Alternate", line1: "10 Ford St", city: "Ogdensburg", state: "NY", postalCode: "13669" });

    const orderId = randomUUID();
    await sql`INSERT INTO ordering_orders(id,business,source,customer_id,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot) VALUES(${orderId},'Corner Deli','pos',${b.customer.id},'draft','unpaid','delivery','CRM-V','validation','Sara','Smyth',${`+1${otherPhone}`})`;
    await sql`UPDATE ordering_customers SET first_name='Changed',display_name='Changed Smyth' WHERE id=${b.customer.id}`;
    await mergeCustomers({ business: "Corner Deli", survivorId: a.customer.id, mergedId: b.customer.id, actorId: "manager-validation" });

    const order = (await sql`SELECT customer_id,first_name_snapshot,phone_snapshot FROM ordering_orders WHERE id=${orderId}`)[0];
    const merged = (await sql`SELECT active,merged_into_customer_id FROM ordering_customers WHERE id=${b.customer.id}`)[0];
    const event = await sql`SELECT field_choices FROM ordering_customer_merge_events WHERE surviving_customer_id=${a.customer.id} AND merged_customer_id=${b.customer.id}`;
    const current = await findCustomers("Corner Deli", mainPhone);
    const canonical = current.find((customer) => customer.id === a.customer.id);
    if (!canonical || canonical.phones.length !== 3 || canonical.addresses.length !== 4) throw new Error("Merged child collections were not preserved/deduplicated.");
    if (canonical.phones.filter((item: { normalized_phone: string }) => item.normalized_phone === `+1${mainPhone}`).length !== 1) throw new Error("Matching normalized phones were not deduplicated during merge.");
    if (order.customer_id !== a.customer.id || order.first_name_snapshot !== "Sara" || order.phone_snapshot !== `+1${otherPhone}`) throw new Error("Order association/snapshot acceptance failed.");
    if (merged.active || merged.merged_into_customer_id !== a.customer.id || !event.length) throw new Error("Customer merge/audit acceptance failed.");
    summary = JSON.stringify({ normalizedLookup: true, duplicatePrevented: true, explicitSharedPhone: true, phoneCount: 3, initialAddressCount: 3, selectedPhoneAndAddressSnapshots: true, mergedAddressCount: 4, orderReassociated: true, historicalSnapshotsUnchanged: true, loserMarkedMerged: true, mergeAudit: true }, null, 2);
    throw new Error(ROLLBACK);
  }); } catch (error) { if (!(error instanceof Error) || error.message !== ROLLBACK) throw error; }
  if ((await getSql()`SELECT id FROM ordering_customer_phones WHERE normalized_phone IN (${`+1${mainPhone}`},${`+1${workNumber}`},${`+1${otherPhone}`})`).length) throw new Error("Customer CRM validation left test customers behind.");
  console.log(summary);
  process.exit();
})().catch((error) => { console.error(error); process.exit(1); });

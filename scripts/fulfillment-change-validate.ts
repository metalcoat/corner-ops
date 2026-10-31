#!/usr/bin/env node
// Switching an open order between pickup and delivery reprices it straight away.
// Runs against the dev database with live address lookups; every fixture is rolled back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:fulfillment-change-validation";

async function main(): Promise<void> {
  if (!process.env.GOOGLE_MAPS_API_KEY) { console.log(JSON.stringify({ skipped: "GOOGLE_MAPS_API_KEY is not set" })); return; }
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder, reopenOrderForAdditions, OrderConflictError } = await import("../src/lib/ordering-order-lifecycle");
  const { changeOrderFulfillment, DeliveryAddressNeededError } = await import("../src/lib/ordering-fulfillment-change");
  const { createAddressValidationToken, validateDeliveryAddress } = await import("../src/lib/ordering-address");
  const { getOrderDetail } = await import("../src/lib/ordering-order-center");
  const { listUnresolvedVoidMoney } = await import("../src/lib/ordering-void-money");
  const { addCustomerAddress, createCustomer } = await import("../src/lib/ordering-customers");
  await ensureOrderingPosSchema();
  const manager = { id: "fulfillment-manager", name: "Manager", type: "employee" as const, role: "manager" as const };
  const results: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const item = (await sql`
        SELECT i.id FROM ordering_menu_items i
        WHERE i.business='Corner Deli' AND i.active AND i.available AND i.base_price_cents>0
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id)
        ORDER BY i.base_price_cents DESC LIMIT 1`)[0];
      const draft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: manager.id,
        customerFirstName: "Switch", callerPhone: "3155550181",
        items: [{ itemId: String(item.id), quantity: 3 }],
      });
      const id = String(draft.id);
      const row = async () => (await sql`SELECT service_type,status,payment_status,delivery_fee_cents,total_cents,paid_cents,amount_due_cents FROM ordering_orders WHERE id=${id}`)[0];
      await submitDraftOrder(id, "Corner Deli", manager);
      const start = await row();
      const pickupTotal = Number(start.total_cents);

      await assert.rejects(changeOrderFulfillment(id, "Corner Deli", manager, { serviceType: "delivery" }), OrderConflictError);
      results.sentOrderMustBeReopened = true;

      await reopenOrderForAdditions(id, "Corner Deli", manager);
      await assert.rejects(changeOrderFulfillment(id, "Corner Deli", manager, { serviceType: "delivery" }), DeliveryAddressNeededError);
      assert.equal((await row()).service_type, "pickup");
      results.noAddressLeavesOrderAlone = true;

      const known = await sql`SELECT DISTINCT formatted_address FROM ordering_order_delivery_addresses WHERE validation_status='validated' AND route_distance_miles<5`;
      const usable: Array<{ entered: string; address: Awaited<ReturnType<typeof validateDeliveryAddress>> }> = [];
      for (const row of known) {
        if (usable.length === 2) break;
        const entered = String(row.formatted_address);
        await validateDeliveryAddress({ enteredAddress: entered, sessionToken: randomUUID() }).then((address) => usable.push({ entered, address })).catch(() => undefined);
      }
      assert.equal(usable.length, 2, "two deliverable addresses");
      const [{ entered, address }, { entered: otherEntered, address: other }] = usable;
      await changeOrderFulfillment(id, "Corner Deli", manager, { serviceType: "delivery", deliveryAddress: entered, deliveryUnit: "Apt 2", deliveryValidationToken: createAddressValidationToken(address) });
      const delivery = await row(), feeCents = Number(delivery.delivery_fee_cents);
      assert.equal(delivery.service_type, "delivery");
      assert.ok(feeCents > 0, "delivery fee added");
      assert.equal(Number(delivery.total_cents), pickupTotal + feeCents);
      assert.equal(Number(delivery.amount_due_cents), pickupTotal + feeCents);
      results.deliveryFeeAddedCents = feeCents;

      await submitDraftOrder(id, "Corner Deli", manager);
      const ticket = (await sql`SELECT payload FROM ordering_print_jobs WHERE order_id=${id} AND event_subtype='order_addition' ORDER BY created_at DESC LIMIT 1`)[0];
      assert.ok((ticket.payload.lines as string[]).includes("SERVICE CHANGE: PICKUP -> DELIVERY"));
      results.kitchenToldAfterSend = true;

      await sql`INSERT INTO ordering_delivery_assignments(id,order_id,business,status,assigned_by) VALUES(${randomUUID()},${id},'Corner Deli','EN_ROUTE','validation')`;
      await reopenOrderForAdditions(id, "Corner Deli", manager);
      await assert.rejects(changeOrderFulfillment(id, "Corner Deli", manager, { serviceType: "pickup" }), OrderConflictError);
      assert.equal((await row()).service_type, "delivery");
      results.driverOutBlocksPickup = true;

      await sql`UPDATE ordering_delivery_assignments SET status='ASSIGNED' WHERE order_id=${id}`;
      await sql`UPDATE ordering_orders SET paid_cents=total_cents,amount_due_cents=0,payment_status='paid' WHERE id=${id}`;
      await changeOrderFulfillment(id, "Corner Deli", manager, { serviceType: "pickup" });
      const pickup = await row();
      assert.equal(pickup.service_type, "pickup");
      assert.equal(Number(pickup.delivery_fee_cents), 0);
      assert.equal(Number(pickup.total_cents), pickupTotal);
      assert.equal(pickup.payment_status, "paid");
      assert.equal((await getOrderDetail("Corner Deli", id))?.delivery_address, null);
      assert.equal((await sql`SELECT status FROM ordering_delivery_assignments WHERE order_id=${id}`)[0].status, "CANCELLED");
      await submitDraftOrder(id, "Corner Deli", manager);
      const owed = (await listUnresolvedVoidMoney("Corner Deli", id))[0];
      assert.equal(owed?.owedCents, feeCents);
      results.paidFeeRemovedShowsAsOwed = true;
      await reopenOrderForAdditions(id, "Corner Deli", manager);

      await changeOrderFulfillment(id, "Corner Deli", manager, { serviceType: "delivery" });
      const again = await row();
      assert.equal(Number(again.delivery_fee_cents), feeCents);
      assert.equal(Number(again.amount_due_cents), 0);
      assert.equal(again.payment_status, "paid");
      results.switchBackReusesOrderAddress = true;

      await changeOrderFulfillment(id, "Corner Deli", manager, { serviceType: "delivery", deliveryAddress: otherEntered, deliveryValidationToken: createAddressValidationToken(other) });
      assert.equal((await getOrderDetail("Corner Deli", id))?.delivery_address, other.formattedAddress);
      results.deliveryAddressCanChange = true;

      const customer = await createCustomer({ business: "Corner Deli", firstName: "Switch", lastName: "Saved", phone: "3155550182" });
      await addCustomerAddress({ business: "Corner Deli", customerId: String(customer.id), line1: address.line1, city: address.city, state: address.state, postalCode: address.postalCode });
      const savedDraft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: manager.id, customerId: String(customer.id),
        customerFirstName: "Switch", callerPhone: "3155550182",
        items: [{ itemId: String(item.id), quantity: 3 }],
      });
      const updated = await changeOrderFulfillment(String(savedDraft.id), "Corner Deli", manager, { serviceType: "delivery" });
      assert.equal(updated.service_type, "delivery");
      assert.ok(Number(updated.delivery_fee_cents) > 0);
      results.savedCustomerAddressUsed = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

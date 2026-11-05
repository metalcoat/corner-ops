#!/usr/bin/env node
// Refunds and voids from the manager portal (manager-portal-refunds.ts): the same money
// paths as the POS, refunded orders read Refunded (not unpaid), and the trail says
// "from manager portal". Runs against the dev database; every fixture is rolled back.
// Card payments use the "test" provider, so MX is not called.
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:manager-portal-refund-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingAccountSchema } = await import("../src/lib/ordering-account-schema");
  const { commitTender } = await import("../src/lib/ordering-payments");
  const { portalRefundAmount, portalRefundItem, portalVoidOrder, refundableTenders } = await import("../src/lib/manager-portal-refunds");
  const { orderSearchDetail } = await import("../src/lib/ordering-order-search");
  const { orderPaymentState } = await import("../src/lib/order-payment-state");
  await ensureOrderingAccountSchema();
  const manager = { id: "portal-refund-manager", name: "Portal Manager", type: "employee" as const, role: "manager" as const };
  const results: Record<string, unknown> = {};
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const menuItem = (await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' LIMIT 1`)[0];
      check(menuItem, "A menu item is required.");
      const customerId = randomUUID(), orderId = randomUUID(), lineId = randomUUID();
      await sql`INSERT INTO ordering_customers(id,business,display_name) VALUES(${customerId},'Corner Deli','Portal Refund Test')`;
      await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,subtotal_cents,total_cents,paid_cents,amount_due_cents,created_by,customer_id,first_name_snapshot,phone_snapshot,submitted_at)
        VALUES(${orderId},'Corner Deli','pos','ready','unpaid','pickup','PR-1',2000,2000,0,2000,'portal-refund-validation',${customerId},'Portal','3155550180',NOW())`;
      await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${lineId},${orderId},${menuItem.id},'Validation item',2,1000,2000)`;
      await commitTender({ orderId, business: "Corner Deli", tenderType: "card", amountTenderedCents: 2000, clientMutationId: randomUUID(), actor: manager,
        providerApproval: { provider: "test", transactionReference: `test-${randomUUID()}` } });
      const [card] = await refundableTenders(orderId);
      check(card?.remainingCents === 2000, "The card payment should have $20 to give back.");

      // A part refund on an order that's still open (ready) is money back, not a balance due again.
      await portalRefundAmount({ orderId, transactionId: card.id, amountCents: 500, method: "original", reason: "Missing side", clientMutationId: randomUUID(), actor: manager });
      let order = (await sql`SELECT payment_status,paid_cents,amount_due_cents FROM ordering_orders WHERE id=${orderId}`)[0];
      check(order.payment_status === "partially_refunded" && Number(order.paid_cents) === 1500 && Number(order.amount_due_cents) === 0, `Part refund left ${JSON.stringify(order)}.`);
      let detail = await orderSearchDetail(orderId);
      check(detail && orderPaymentState(detail).label === "Partially refunded", "The portal should read Partially refunded.");
      check(detail?.trail.some((row) => row.label === "Refunded $5.00" && row.who === "Portal Manager" && row.detail?.includes("Missing side · from manager portal")), "The trail should show the portal refund, who and why.");
      results.partRefundReadsRefunded = true;

      // Refund one of the two items: takes it off the order and gives its $10 back.
      const item = await portalRefundItem({ orderId, itemId: lineId, quantity: 1, method: "original", reason: "Wrong sandwich", clientMutationId: randomUUID(), actor: manager });
      check(item.amountCents === 1000, `Item refund should be $10, got ${item.amountCents}.`);
      order = (await sql`SELECT payment_status,paid_cents,total_cents FROM ordering_orders WHERE id=${orderId}`)[0];
      check(Number(order.paid_cents) === 500 && Number(order.total_cents) === 1000, `Item refund left ${JSON.stringify(order)}.`);
      detail = await orderSearchDetail(orderId);
      check(detail?.trail.some((row) => row.label === "Item voided" && row.detail?.includes("$10.00 refunded") && row.detail.includes("from manager portal")), "The trail should show the item refund from the portal.");
      results.itemRefund = true;

      // Void the rest and refund what's left.
      const voided = await portalVoidOrder({ orderId, reason: "Customer left", refund: "original", clientMutationId: randomUUID(), actor: manager });
      check(voided.refunds.length === 1 && voided.refunds[0].ok && voided.refunds[0].amountCents === 500, `Void refunds: ${JSON.stringify(voided.refunds)}.`);
      order = (await sql`SELECT status,payment_status,paid_cents,voided_at FROM ordering_orders WHERE id=${orderId}`)[0];
      check(order.status === "cancelled" && order.voided_at && order.payment_status === "refunded" && Number(order.paid_cents) === 0, `Void left ${JSON.stringify(order)}.`);
      detail = await orderSearchDetail(orderId);
      check(detail && orderPaymentState(detail).label === "Voided · refunded", "A voided, refunded order should say so.");
      check(detail?.trail.some((row) => row.label === "Voided" && row.detail === "Customer left · from manager portal"), "The trail should show the portal void.");
      check((await refundableTenders(orderId)).length === 0, "Nothing should be left to refund.");
      results.voidAndRefund = true;

      // Part of a cash order with a customer goes back as store credit (owner rule), even when asked for cash.
      const cashOrder = randomUUID(), cashPayment = randomUUID();
      await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,subtotal_cents,total_cents,paid_cents,amount_due_cents,created_by,customer_id,first_name_snapshot,submitted_at,paid_at)
        VALUES(${cashOrder},'Corner Deli','pos','completed','paid','pickup','PR-2',2000,2000,2000,0,'portal-refund-validation',${customerId},'Portal',NOW(),NOW())`;
      await sql`INSERT INTO ordering_payment_transactions(id,business,order_id,customer_id,tender_type,transaction_type,status,amount_cents,amount_tendered_cents,provider,client_mutation_id,created_by,approved_at)
        VALUES(${cashPayment},'Corner Deli',${cashOrder},${customerId},'cash','payment','approved',2000,2000,'cash',${randomUUID()},'portal-refund-validation',NOW())`;
      const cash = await portalRefundAmount({ orderId: cashOrder, transactionId: cashPayment, amountCents: 700, method: "original", reason: "Cold fries", clientMutationId: randomUUID(), actor: manager });
      const credit = (await sql`SELECT COALESCE(SUM(delta_balance_cents),0)::int balance FROM ordering_store_credit_ledger WHERE customer_id=${customerId}`)[0];
      check(cash.method === "store credit" && cash.forcedCredit && Number(credit.balance) === 700, `Cash part refund: ${JSON.stringify(cash)}, credit ${credit.balance}.`);
      results.cashPartBecomesCredit = true;

      // Only managers and owners; too much, or no reason, is refused.
      let blocked = 0;
      try { await portalRefundAmount({ orderId: cashOrder, transactionId: cashPayment, amountCents: 100, method: "store_credit", reason: "Test", clientMutationId: randomUUID(), actor: { ...manager, role: "employee" } }); } catch { blocked += 1; }
      try { await portalRefundAmount({ orderId: cashOrder, transactionId: cashPayment, amountCents: 1400, method: "store_credit", reason: "Test", clientMutationId: randomUUID(), actor: manager }); } catch { blocked += 1; }
      try { await portalRefundAmount({ orderId: cashOrder, transactionId: cashPayment, amountCents: 100, method: "store_credit", reason: "", clientMutationId: randomUUID(), actor: manager }); } catch { blocked += 1; }
      check(blocked === 3, "An employee, an over-refund and a missing reason should all be refused.");
      results.refusals = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

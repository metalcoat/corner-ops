#!/usr/bin/env node
// Part of a cash order is left as store credit, and the manager report shows it.
// Runs against the dev database; every fixture is rolled back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:manager-report-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder } = await import("../src/lib/ordering-order-lifecycle");
  const { cancelOrderItem } = await import("../src/lib/ordering-item-cancellations");
  const { resolveVoidMoney } = await import("../src/lib/ordering-void-money");
  const { PaymentConflictError } = await import("../src/lib/ordering-payments");
  const { createCustomer } = await import("../src/lib/ordering-customers");
  const { managerReport, managerReportRange } = await import("../src/lib/ordering-manager-report");
  const { businessDateOf } = await import("../src/lib/ordering-registers");
  await ensureOrderingPosSchema();
  assert.deepEqual(managerReportRange("week", "2026-10-30"), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(managerReportRange("week", "2026-11-01"), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(managerReportRange("month", "2026-02-10"), { start: "2026-02-01", end: "2026-02-28" });
  const manager = { id: "manager-report-manager", name: "Manager", type: "employee" as const, role: "manager" as const };
  const results: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const items = await sql`
        SELECT i.id FROM ordering_menu_items i
        WHERE i.business='Corner Deli' AND i.active AND i.available AND i.base_price_cents>0
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id)
        ORDER BY i.base_price_cents DESC LIMIT 1`;
      const cashOrder = async (customerId?: string) => {
        const draft = await createDraftOrderWithVariants({
          business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: manager.id, customerId,
          customerFirstName: "Refund", callerPhone: "3155550183",
          items: [{ itemId: String(items[0].id), quantity: 3 }],
        });
        const id = String(draft.id);
        await submitDraftOrder(id, "Corner Deli", manager);
        const transactionId = randomUUID();
        const order = (await sql`UPDATE ordering_orders SET paid_cents=total_cents,amount_due_cents=0,payment_status='paid',status='completed' WHERE id=${id} RETURNING total_cents`)[0];
        await sql`INSERT INTO ordering_payment_transactions(id,business,order_id,tender_type,transaction_type,status,amount_cents,provider,client_mutation_id,created_by,approved_at) VALUES(${transactionId},'Corner Deli',${id},'cash','payment','approved',${order.total_cents},'cash',${randomUUID()},${manager.id},NOW())`;
        const itemId = String((await sql`SELECT id FROM ordering_order_items WHERE order_id=${id} LIMIT 1`)[0].id);
        return { id, itemId, transactionId };
      };
      const customer = String((await createCustomer({ business: "Corner Deli", firstName: "Refund", lastName: "Credit", phone: "3155550183" })).customer.id);
      const before = await managerReport({ view: "day", date: businessDateOf(new Date()) });

      const withCustomer = await cashOrder(customer);
      await cancelOrderItem({ orderId: withCustomer.id, itemId: withCustomer.itemId, quantity: 1, reason: "Forgot it", paymentTransactionId: withCustomer.transactionId, refundMethod: "original", clientMutationId: randomUUID(), actor: manager });
      const reversals = await sql`SELECT tender_type FROM ordering_payment_transactions WHERE order_id=${withCustomer.id} AND transaction_type IN('refund','void')`;
      assert.deepEqual(reversals.map((row) => row.tender_type), ["store_credit"]);
      const credit = (await sql`SELECT delta_balance_cents FROM ordering_store_credit_ledger WHERE order_id=${withCustomer.id}`)[0];
      assert.ok(Number(credit.delta_balance_cents) > 0);
      results.partialCashBecomesCredit = Number(credit.delta_balance_cents);

      await cancelOrderItem({ orderId: withCustomer.id, itemId: withCustomer.itemId, quantity: 1, reason: "Later", refundMethod: "later", clientMutationId: randomUUID(), actor: manager });
      await assert.rejects(resolveVoidMoney({ business: "Corner Deli", orderId: withCustomer.id, transactionId: withCustomer.transactionId, amountCents: 100, method: "refund", reason: "Cash back", clientMutationId: randomUUID(), actor: manager }), PaymentConflictError);
      results.needsRefundPanelCantHandBackCash = true;

      const noCustomer = await cashOrder();
      await cancelOrderItem({ orderId: noCustomer.id, itemId: noCustomer.itemId, quantity: 1, reason: "Forgot it", paymentTransactionId: noCustomer.transactionId, refundMethod: "original", clientMutationId: randomUUID(), actor: manager });
      assert.equal((await sql`SELECT tender_type FROM ordering_payment_transactions WHERE order_id=${noCustomer.id} AND transaction_type IN('refund','void')`)[0].tender_type, "cash");
      results.noCustomerRefundsCash = true;

      const after = await managerReport({ view: "day", date: businessDateOf(new Date()) });
      assert.equal(after.totals.creditIssuedCents - before.totals.creditIssuedCents, Number(credit.delta_balance_cents));
      assert.ok(after.credits.some((row) => row.orderId === withCustomer.id && row.kind === "refund"));
      assert.ok(after.refunds.every((row) => row.orderId !== withCustomer.id));
      assert.ok(after.refunds.some((row) => row.orderId === noCustomer.id));
      assert.equal(after.voidedItems.filter((row) => row.orderId === withCustomer.id).length, 2);
      assert.ok(after.stillOwed.some((row) => row.orderId === withCustomer.id));
      results.reportShowsIt = true;

      const week = await managerReport({ view: "week", date: businessDateOf(new Date()) });
      const month = await managerReport({ view: "month", date: "2026-10-15" });
      assert.ok(week.byDay.length >= 1 && week.byDay.length <= 7);
      assert.ok(month.byDay.length >= 28);
      results.historyDays = { week: week.byDay.length, october: month.byDay.length, octoberCalls: month.calls.total, octoberMissed: month.calls.missed, tillRows: month.tills.length };
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

#!/usr/bin/env node
// Money left on voided orders must be refunded or left as store credit by end of
// day (ordering-void-money.ts). Runs against the dev database; every fixture is rolled back.
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:void-money-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingAccountSchema } = await import("../src/lib/ordering-account-schema");
  const { commitTender } = await import("../src/lib/ordering-payments");
  const { voidSentOrder } = await import("../src/lib/ordering-voids");
  const { listUnresolvedVoidMoney, resolveVoidMoney, remindUnresolvedVoidMoney } = await import("../src/lib/ordering-void-money");
  await ensureOrderingAccountSchema();
  const manager = { id: "void-money-manager", name: "Manager", type: "employee" as const, role: "manager" as const };
  const results: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const customerId = randomUUID(), orderId = randomUUID();
      await sql`INSERT INTO ordering_customers(id,business,display_name) VALUES(${customerId},'Corner Deli','Void Money Test')`;
      await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,subtotal_cents,total_cents,paid_cents,amount_due_cents,created_by,customer_id,first_name_snapshot,phone_snapshot,submitted_at)
        VALUES(${orderId},'Corner Deli','web','sent_to_kitchen','unpaid','pickup','VM-1',2000,2000,0,2000,'void-money-validation',${customerId},'Void','3155550179',NOW())`;
      const paid = await commitTender({ orderId, business: "Corner Deli", tenderType: "card", amountTenderedCents: 2000, clientMutationId: randomUUID(), actor: manager,
        providerApproval: { provider: "test", transactionReference: `test-${randomUUID()}` } });
      const tenderId = String((paid.tenders as Array<Record<string, unknown>>).find((row) => row.transaction_type === "payment")?.id);
      if ((await listUnresolvedVoidMoney("Corner Deli")).some((row) => row.orderId === orderId)) throw new Error("A paid, active order was listed as owed.");
      await voidSentOrder({ orderId, business: "Corner Deli", reason: "Customer cancelled", actor: manager });
      const owed = (await listUnresolvedVoidMoney("Corner Deli")).find((row) => row.orderId === orderId);
      if (owed?.owedCents !== 2000) throw new Error(`A voided paid order should owe 2000, got ${owed?.owedCents}.`);
      results.voidedOrderListed = true;
      await resolveVoidMoney({ business: "Corner Deli", orderId, transactionId: tenderId, amountCents: 500, method: "store_credit", reason: "", clientMutationId: randomUUID(), actor: manager });
      const credit = (await sql`SELECT COALESCE(SUM(delta_balance_cents),0)::int balance FROM ordering_store_credit_ledger WHERE customer_id=${customerId}`)[0];
      if (Number(credit.balance) !== 500) throw new Error("Store credit was not left on the account.");
      const afterCredit = (await listUnresolvedVoidMoney("Corner Deli")).find((row) => row.orderId === orderId);
      if (afterCredit?.owedCents !== 1500) throw new Error("Owed amount didn't drop after the credit.");
      results.storeCreditLeft = true;
      await resolveVoidMoney({ business: "Corner Deli", orderId, transactionId: tenderId, amountCents: 1500, method: "refund", reason: "", clientMutationId: randomUUID(), actor: manager });
      if ((await listUnresolvedVoidMoney("Corner Deli")).some((row) => row.orderId === orderId)) throw new Error("The order is still owed after refunding the rest.");
      results.refundClearsIt = true;
      let employeeBlocked = false;
      try { await resolveVoidMoney({ business: "Corner Deli", orderId, transactionId: tenderId, amountCents: 1, method: "refund", reason: "", clientMutationId: randomUUID(), actor: { ...manager, role: "employee" } }); }
      catch { employeeBlocked = true; }
      if (!employeeBlocked) throw new Error("An employee resolved voided money.");
      results.managerOnly = true;
      // Closing reminder: once per business day, after close.
      const late = new Date(); late.setUTCHours(23, 59, 0, 0);
      await sql`UPDATE ordering_orders SET paid_cents=2000 WHERE id=${orderId}`; // owed again, for the reminder
      // Never email from a test: dev holds real mail settings.
      const sent: string[] = [];
      const fakeSend = async (message: { subject: string }) => { sent.push(message.subject); return { configured: true, sent: 1, failures: [] }; };
      const first = await remindUnresolvedVoidMoney("Corner Deli", new Date(late.getTime() + 4 * 3_600_000), fakeSend);
      const second = await remindUnresolvedVoidMoney("Corner Deli", new Date(late.getTime() + 4 * 3_600_000), fakeSend);
      if (sent.length !== 1) throw new Error("The closing reminder should go out exactly once.");
      results.reminder = { first: first.sent ? "sent" : (first as { reason?: string }).reason, second: (second as { reason?: string }).reason };
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

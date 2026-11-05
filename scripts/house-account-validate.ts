#!/usr/bin/env node
// House accounts (ordering-house-accounts.ts) against the dev database: open an account, charge
// orders to it through commitTender, the limit and hold refusals, payments and credits, the
// statement and charge slip, and refunds / voids taking the charge back off the tab.
// Every fixture is rolled back.
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:house-account-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { commitTender, reverseTender, settleTenderAsStoreCredit, printPaidReceipt } = await import("../src/lib/ordering-payments");
  const { voidSentOrder } = await import("../src/lib/ordering-voids");
  const houses = await import("../src/lib/ordering-house-accounts");
  const { orderSearchDetail } = await import("../src/lib/ordering-order-search");
  const manager = { id: "house-account-manager", name: "House Manager", type: "employee" as const, role: "manager" as const };
  const cashier = { id: "house-account-cashier", name: "House Cashier", type: "employee" as const, role: "employee" as const };
  const results: Record<string, unknown> = {};
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  try {
    await withTransaction(async () => {
      const sql = getSql();
      // A refusal inside commitTender happens after the payment row is written; in a request the whole
      // transaction rolls back, here a savepoint does.
      const refused = async (run: () => Promise<unknown>, pattern: RegExp, message: string) => {
        await sql`SAVEPOINT house_refusal`;
        let error = "";
        try { await run(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        await sql`ROLLBACK TO SAVEPOINT house_refusal`;
        check(pattern.test(error), `${message} (got "${error || "no error"}").`);
      };
      const menuItem = (await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' LIMIT 1`)[0];
      check(menuItem, "A menu item is required.");
      let number = 0;
      const order = async (totalCents: number) => {
        const orderId = randomUUID();
        number += 1;
        await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,subtotal_cents,total_cents,paid_cents,amount_due_cents,created_by,first_name_snapshot,phone_snapshot,submitted_at)
          VALUES(${orderId},'Corner Deli','pos','ready','unpaid','pickup',${`HA-${number}`},${totalCents},${totalCents},0,${totalCents},'house-account-validation','Mike','5185550100',NOW())`;
        await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${randomUUID()},${orderId},${menuItem.id},'Italian sub',1,${totalCents},${totalCents})`;
        return orderId;
      };
      const charge = (orderId: string, accountId: string, amountCents: number, actor = cashier) =>
        commitTender({ orderId, business: "Corner Deli", tenderType: "house_account", amountTenderedCents: amountCents, houseAccountId: accountId, clientMutationId: randomUUID(), actor });
      const balance = async (id: string) => (await houses.houseAccountDetail(id))!.account.balanceCents;

      // Open an account; only managers can.
      await refused(() => houses.saveHouseAccount({ name: "Nope", actor: cashier }), /Manager/, "A cashier should not open accounts");
      const accountId = await houses.saveHouseAccount({ name: "Mike Russell (validation)", phone: "518-555-0100", creditLimitCents: 5000, actor: manager });
      check((await houses.searchChargeableHouseAccounts("555-0100")).some((row) => row.id === accountId), "Search by phone should find the account.");
      check((await houses.searchChargeableHouseAccounts("russell (valid")).some((row) => row.id === accountId), "Search by name should find the account.");
      await refused(() => houses.saveHouseAccount({ name: "mike russell (VALIDATION)", actor: manager }), /already an open house account/, "A second open account with the same name should be refused");
      results.openAndSearch = true;

      // Charge an order: paid in full, ledger entry with who and where, event on the trail, slip on the receipt.
      const first = await order(1250);
      const paid = await charge(first, accountId, 1250);
      check(paid.order.payment_status === "paid" && Number(paid.order.amount_due_cents) === 0, `The charged order should be paid: ${JSON.stringify(paid.order)}.`);
      const entry = (await sql`SELECT * FROM ordering_house_account_ledger WHERE order_id=${first}`)[0];
      check(entry?.entry_type === "charge" && Number(entry.delta_balance_cents) === 1250 && entry.actor_name === "House Cashier" && entry.reference === "HA-1" && Number(entry.balance_after_cents) === 1250, `Charge entry: ${JSON.stringify(entry)}.`);
      const tender = paid.tenders.find((row) => row.tender_type === "house_account");
      check(tender && entry.payment_transaction_id === tender.id, "The ledger entry should point at the payment.");
      const payJob = (await sql`SELECT payload FROM ordering_print_jobs WHERE payment_transaction_id=${tender!.id}`)[0];
      check(payJob?.payload?.houseAccountLines?.includes("HOUSE ACCOUNT: Mike Russell (validation)"), "The payment receipt should carry the charge slip.");
      const receipt = await printPaidReceipt({ orderId: first, business: "Corner Deli", itemized: true, actor: cashier });
      const receiptJob = (await sql`SELECT payload FROM ordering_print_jobs WHERE id=${receipt.printJobId}`)[0];
      check(receiptJob.payload.houseAccountLines?.includes("ACCOUNT BALANCE: $12.50"), "The paid receipt printed later should carry the slip too.");
      let detail = await orderSearchDetail(first);
      check(detail?.trail.some((row) => row.label === "Charged to house account $12.50" && row.who === "House Cashier" && row.detail?.includes("Mike Russell (validation)")), "The order trail should show the charge.");
      check(await balance(accountId) === 1250, "Balance should be $12.50.");
      results.charge = true;

      // A charge can't go past the limit, or onto an account on hold or closed; nor more than is due.
      const second = await order(4000);
      await refused(() => charge(second, accountId, 4000), /Over the \$50\.00 limit/, "A charge past the limit should be refused");
      await refused(() => charge(second, accountId, 4100), /more than the balance due/, "A charge over the balance due should be refused");
      await houses.setHouseAccountStatus({ id: accountId, status: "hold", actor: manager });
      await refused(() => charge(second, accountId, 1000), /on hold/, "An account on hold should not take charges");
      await houses.setHouseAccountStatus({ id: accountId, status: "active", actor: manager });
      check((await sql`SELECT COUNT(*)::int n FROM ordering_house_account_ledger WHERE account_id=${accountId}`)[0].n === 1, "Refused charges should leave no ledger entries.");
      // Split: part on the tab, the rest owed.
      const split = await charge(second, accountId, 3000);
      check(split.order.payment_status === "partially_paid" && Number(split.order.amount_due_cents) === 1000, "A part charge should leave the rest due.");
      check(await balance(accountId) === 4250, "Balance should be $42.50.");
      results.refusals = true;

      // A refund takes the charge back off the tab; store credit is refused for a house-account payment.
      const secondTender = split.tenders.find((row) => row.tender_type === "house_account")!;
      await refused(() => settleTenderAsStoreCredit({ orderId: second, transactionId: secondTender.id, refundCents: 500, creditCents: 500, clientMutationId: randomUUID(), reason: "Test credit", actor: manager }), /charged to a house account/, "Store credit should be refused for a house-account payment");
      await reverseTender({ orderId: second, business: "Corner Deli", transactionId: secondTender.id, amountCents: 3000, clientMutationId: randomUUID(), reason: "Wrong account", actor: manager });
      check(await balance(accountId) === 1250, "A refund should take $30 off the tab.");
      const reversal = (await sql`SELECT * FROM ordering_house_account_ledger WHERE order_id=${second} AND entry_type='reversal'`)[0];
      check(reversal && Number(reversal.delta_balance_cents) === -3000 && reversal.actor_name === "House Manager", `Reversal entry: ${JSON.stringify(reversal)}.`);
      results.refundReverses = true;

      // Voiding a charged order reverses the charge by itself.
      const third = await order(900);
      await charge(third, accountId, 900);
      check(await balance(accountId) === 2150, "Balance should be $21.50.");
      await voidSentOrder({ orderId: third, business: "Corner Deli", reason: "Customer cancelled", actor: manager });
      check(await balance(accountId) === 1250, "Voiding the order should take its charge off the tab.");
      const voided = (await sql`SELECT payment_status,paid_cents FROM ordering_orders WHERE id=${third}`)[0];
      check(voided.payment_status === "refunded" && Number(voided.paid_cents) === 0, `A voided house-account order: ${JSON.stringify(voided)}.`);
      detail = await orderSearchDetail(third);
      check(detail?.trail.some((row) => row.label === "House-account charge reversed $9.00" && row.detail?.includes("Order voided: Customer cancelled")), "The trail should show the reversal.");
      results.voidReverses = true;

      // Payments and credits: managers only, credits need a reason, checks need a number.
      await refused(() => houses.recordHouseAccountPayment({ id: accountId, amountCents: 500, method: "cash", actor: cashier }), /Manager/, "A cashier should not record payments");
      await refused(() => houses.recordHouseAccountPayment({ id: accountId, amountCents: 500, method: "check", actor: manager }), /check number/, "A check needs its number");
      await refused(() => houses.recordHouseAccountAdjustment({ id: accountId, amountCents: 100, direction: "credit", reason: "", actor: manager }), /reason/, "A credit needs a reason");
      await houses.recordHouseAccountPayment({ id: accountId, amountCents: 1000, method: "check", reference: "1042", actor: manager });
      await houses.recordHouseAccountAdjustment({ id: accountId, amountCents: 150, direction: "credit", reason: "Cold soup", actor: manager });
      check(await balance(accountId) === 100, "Balance should be $1.00 after the payment and credit.");
      const audit = (await sql`SELECT action FROM ordering_operations_audit WHERE target_type='house_account' AND target_id=${accountId} ORDER BY created_at`).map((row) => row.action);
      check(audit.includes("house_account_payment") && audit.includes("house_account_adjustment") && audit.includes("house_account_created"), `Audit: ${audit.join(", ")}.`);
      results.paymentsAndCredits = true;

      // The statement: default since the last payment (today), every entry with its running balance.
      const statement = (await houses.houseAccountStatement({ id: accountId, from: "2000-01-01" }))!;
      check(statement.rows.length === 7 && statement.openingCents === 0 && statement.totals.closingCents === 100, `Statement: ${statement.rows.length} rows, closing ${statement.totals.closingCents}.`);
      check(statement.rows[0].orderNumber === "HA-1" && statement.rows[0].items === "1x Italian sub" && statement.rows[0].balanceCents === 1250, `First row: ${JSON.stringify(statement.rows[0])}.`);
      const fallback = (await houses.houseAccountStatement({ id: accountId }))!;
      check(fallback.from === houses.storeToday() && fallback.to === houses.storeToday(), `Default period should start at today's payment: ${fallback.from}–${fallback.to}.`);
      results.statement = true;

      // Closing hides the account from the POS and blocks charges; the history stays.
      await houses.setHouseAccountStatus({ id: accountId, status: "closed", actor: manager });
      check(!(await houses.searchChargeableHouseAccounts("Russell (validation)")).some((row) => row.id === accountId), "A closed account should not show at the POS.");
      check((await houses.listHouseAccounts({ includeClosed: true, query: "Russell (validation)" })).some((row) => row.id === accountId), "A closed account should still be listed when asked.");
      await refused(() => charge(second, accountId, 500), /closed/, "A closed account should not take charges");
      results.close = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

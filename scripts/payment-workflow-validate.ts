#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) {
  throw new Error("Payment validation requires the private local PostgreSQL container.");
}
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

const ROLLBACK = "rollback:payment-workflow-validation";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingAccountSchema } = await import("../src/lib/ordering-account-schema");
  const { ensureOrderingGiftCardSchema } = await import("../src/lib/ordering-gift-card-schema");
  const { commitTender, reprintPaymentReceipt, reverseTender, PaymentConflictError } = await import("../src/lib/ordering-payments");
  await ensureOrderingAccountSchema();
  await ensureOrderingGiftCardSchema();
  const result: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const actor = { id: "payment-test", name: "Payment Test", type: "employee" as const, role: "manager" as const };
      const employee = { ...actor, role: "employee" as const };
      const orderId = randomUUID();
      await sql`
        INSERT INTO ordering_orders (
          id, business, source, status, payment_status, service_type, display_number, created_by,
          first_name_snapshot, last_name_snapshot, phone_snapshot, total_cents, amount_due_cents
        ) VALUES (
          ${orderId}, 'Corner Deli', 'pos', 'sent_to_kitchen', 'unpaid', 'pickup',
          ${`PAY-${orderId.slice(0, 8)}`}, ${actor.id}, 'Payment', 'Test', '+13155550199', 4200, 4200
        )
      `;
      const first = await commitTender({ orderId, business: "Corner Deli", tenderType: "cash", amountTenderedCents: 2000, clientMutationId: "payment-test-cash", actor });
      if (Number(first.order.amount_due_cents) !== 2200 || first.order.payment_status !== "partially_paid") throw new Error("Partial cash payment was incorrect.");
      const duplicate = await commitTender({ orderId, business: "Corner Deli", tenderType: "cash", amountTenderedCents: 2000, clientMutationId: "payment-test-cash", actor });
      if (!duplicate.duplicate || Number(duplicate.order.amount_due_cents) !== 2200) throw new Error("Idempotent retry duplicated payment.");
      const final = await commitTender({ orderId, business: "Corner Deli", tenderType: "card", amountTenderedCents: 2200, clientMutationId: "payment-test-card", actor });
      if (final.order.payment_status !== "paid" || Number(final.order.amount_due_cents) !== 0 || Number(final.order.paid_cents) !== 4200) throw new Error("Mixed payment did not settle order.");
      const printJobs = await sql`SELECT purpose, payload FROM ordering_print_jobs WHERE order_id = ${orderId} ORDER BY created_at`;
      if (printJobs.length !== 2 || printJobs.some((job) => job.purpose !== "payment_update")) throw new Error("Post-send payment updates were not queued correctly.");
      if (printJobs[1].payload.paid !== true || Number(printJobs[1].payload.remainingDueCents) !== 0) throw new Error("Final payment update was not marked PAID.");
      if(Number(printJobs[0].payload.paidThisUpdateCents)!==2000||Number(printJobs[0].payload.totalPaidCents)!==2000||Number(printJobs[0].payload.remainingDueCents)!==2200)throw new Error("Partial PAYMENT UPDATE amounts were incorrect.");
      const cashId=String(first.tenders.find(row=>row.tender_type==="cash")?.id),cardId=String(final.tenders.find(row=>row.tender_type==="card")?.id);
      let employeeBlocked=false;try{await reverseTender({orderId,business:"Corner Deli",transactionId:cashId,amountCents:500,clientMutationId:"payment-test-denied",reason:"Validator denied reversal",actor:employee})}catch(error){employeeBlocked=error instanceof PaymentConflictError}
      if(!employeeBlocked)throw new Error("Employee tender reversal was not blocked.");
      const partial=await reverseTender({orderId,business:"Corner Deli",transactionId:cashId,amountCents:500,clientMutationId:"payment-test-reverse",reason:"Validator partial reversal",actor});
      if(Number(partial.order.paid_cents)!==3700||Number(partial.order.amount_due_cents)!==500||partial.order.payment_status!=="partially_paid")throw new Error("Partial reversal balance was incorrect.");
      const retry=await reverseTender({orderId,business:"Corner Deli",transactionId:cashId,amountCents:500,clientMutationId:"payment-test-reverse",reason:"Validator partial reversal",actor});
      if(!retry.duplicate||Number(retry.order.paid_cents)!==3700)throw new Error("Reversal retry was not idempotent.");
      await reprintPaymentReceipt({orderId,business:"Corner Deli",transactionId:cardId,reason:"Customer requested duplicate",actor:employee});
      const after=await sql`SELECT transaction_type,amount_cents,related_transaction_id,reason FROM ordering_payment_transactions WHERE order_id=${orderId} ORDER BY created_at,id`;
      const jobs=await sql`SELECT purpose,is_reprint,payload FROM ordering_print_jobs WHERE order_id=${orderId} ORDER BY created_at,id`;
      const events=await sql`SELECT event_type,details FROM ordering_order_events WHERE order_id=${orderId} AND event_type IN ('payment_reversed','payment_receipt_reprinted')`;
      if(after.length!==3||after.filter(row=>row.transaction_type==="payment").length!==2||!after.some(row=>row.transaction_type==="void"&&Number(row.amount_cents)===500&&row.related_transaction_id===cashId&&row.reason==="Validator partial reversal"))throw new Error("Immutable reversal ledger was incorrect.");
      if(jobs.length!==3||jobs.filter(row=>row.purpose==="kitchen_production").length||!jobs.some(row=>row.purpose==="paid_receipt"&&row.is_reprint===true))throw new Error("Receipt reprint duplicated payment or kitchen production.");
      if(events.length!==2)throw new Error("Sensitive payment operations were not audited.");
      result.mixedTender = true;
      result.partialBalance = true;
      result.idempotentRetry = true;
      result.paymentUpdateJobs = printJobs.length;
      result.finalUpdatePaid = true;
      result.partialPaymentUpdateAmounts = true;
      result.managerReversalAuthorization = true;
      result.partialReversal = true;
      result.reversalIdempotency = true;
      result.immutableReversalLedger = true;
      result.auditedReceiptReprint = true;
      result.noKitchenTicketDuplication = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

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
  const { commitTender } = await import("../src/lib/ordering-payments");
  await ensureOrderingAccountSchema();
  const result: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const actor = { id: "payment-test", name: "Payment Test", type: "employee" as const };
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
      result.mixedTender = true;
      result.partialBalance = true;
      result.idempotentRetry = true;
      result.paymentUpdateJobs = printJobs.length;
      result.finalUpdatePaid = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });

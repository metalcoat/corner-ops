#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Payment-station validation requires the private local PostgreSQL container.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;
const ROLLBACK = "rollback:payment-station-validation";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingHardwareSchema } = await import("../src/lib/ordering-hardware-schema");
  const { ensureOrderingGiftCardSchema } = await import("../src/lib/ordering-gift-card-schema");
  const { cancelPaymentQueueEntries, queueForPayment, paymentStationProfile } = await import("../src/lib/ordering-payment-stations");
  const { commitTender, reverseTender, setCheckoutTip } = await import("../src/lib/ordering-payments");
  await ensureOrderingHardwareSchema();
  await ensureOrderingGiftCardSchema();
  const result: Record<string, boolean> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql(), suffix = randomUUID().slice(0, 8);
      const actor = { id: "payment-station-test", name: "Payment Station Test", type: "employee" as const, role: "manager" as const };
      const locationId = randomUUID(), printerId = randomUUID(), stationId = randomUUID(), orderStationId = randomUUID(), stationKey = `pay-${suffix}`, orderId = randomUUID();
      await sql`INSERT INTO ordering_hardware_locations(id,business,name,location_key) VALUES(${locationId},'Tiki',${`Station ${suffix}`},${`station-${suffix}`})`;
      await sql`INSERT INTO ordering_hardware_devices(id,business,location_id,name,device_key,device_type,role,adapter_key,adapter_config,created_by,updated_by) VALUES(${printerId},'Tiki',${locationId},${`Till ${suffix}`},${`till-${suffix}`},'printer','receipt_printer','network-printer',${JSON.stringify({ host: "127.0.0.1", port: 9100, tillKey: "Test Till", cashDrawerEnabled: true })}::jsonb,${actor.id},${actor.id})`;
      await sql`INSERT INTO ordering_payment_stations(id,business,name,station_key,station_mode,receipt_printer_id,created_by,updated_by) VALUES(${stationId},'Tiki',${`Payment ${suffix}`},${stationKey},'payment',${printerId},${actor.id},${actor.id}),(${orderStationId},'Tiki',${`Kitchen ${suffix}`},${`kitchen-${suffix}`},'order_taker',NULL,${actor.id},${actor.id})`;
      await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,total_cents,amount_due_cents) VALUES(${orderId},'Tiki','pos','sent_to_kitchen','unpaid','pickup',${`ST-${suffix}`},${actor.id},'Station','Test','+13155550199',3000,3000)`;
      await queueForPayment({ business: "Tiki", orderId, sourceStationKey: `kitchen-${suffix}`, actor });
      const cancelled = await cancelPaymentQueueEntries("Tiki", orderId);
      if (cancelled.length !== 1) throw new Error("Payment queue cancellation did not clear the active request.");
      await queueForPayment({ business: "Tiki", orderId, sourceStationKey: `kitchen-${suffix}`, actor });
      const duplicate = await queueForPayment({ business: "Tiki", orderId, sourceStationKey: `kitchen-${suffix}`, actor });
      if (!duplicate.duplicate) throw new Error("Payment queue retry duplicated the request.");
      const tipped = await setCheckoutTip({ orderId, business: "Tiki", tipCents: 450, actor });
      if (Number(tipped.order.amount_due_cents) !== 3450) throw new Error("Checkout tip was not added to the amount due.");
      const cash = await commitTender({ orderId, business: "Tiki", tenderType: "cash", amountTenderedCents: 2000, clientMutationId: `cash-${suffix}`, actor, receiptPrinterId: printerId, cashControlMode: "till", stationKey });
      const card = await commitTender({ orderId, business: "Tiki", tenderType: "card", amountTenderedCents: 1450, clientMutationId: `card-${suffix}`, actor, providerApproval: { provider: "mx_merchant", transactionReference: `mx-${suffix}` } });
      const cashPayment = cash.tenders.find((row) => row.tender_type === "cash");
      if (!cashPayment) throw new Error("Cash tender was not recorded.");
      await reverseTender({ orderId, business: "Tiki", transactionId: String(cashPayment.id), amountCents: 500, clientMutationId: `refund-${suffix}`, reason: "Station validation refund", actor });
      const profile = await paymentStationProfile("Tiki", stationKey);
      const queueStatuses = (await sql`SELECT status FROM ordering_payment_station_queue WHERE order_id=${orderId}`).map((row) => String(row.status));
      const movements = await sql`SELECT delta_cash_cents FROM ordering_cash_drawer_movements WHERE order_id=${orderId} ORDER BY created_at`;
      if (profile?.station_mode !== "payment" || !queueStatuses.includes("cancelled") || !queueStatuses.includes("completed") || card.order.payment_status !== "paid" || movements.length !== 2 || Number(movements[0].delta_cash_cents) !== 2000 || Number(movements[1].delta_cash_cents) !== -500) throw new Error("Payment station routing or cash ledger validation failed.");
      Object.assign(result, { singlePaymentStation: true, orderTakerQueue: true, queueCancellation: true, queueIdempotency: true, checkoutTip: true, mxProviderLedger: true, cashRegisterLedger: true, cashRefundLedger: true });
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

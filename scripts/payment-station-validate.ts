#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import assert from "node:assert/strict";

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
  const { cancelPaymentQueueEntries, listPaymentQueue, queueForPayment, paymentStationProfile } = await import("../src/lib/ordering-payment-stations");
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
      // Expected failures join this fixture transaction; restore their writes
      // just as the real request boundary rolls back a failed payment.
      await sql`SAVEPOINT rejected_cash`;
      let stationlessCashBlocked = false;
      try { await commitTender({ orderId, business: "Tiki", tenderType: "cash", amountTenderedCents: 2000, clientMutationId: `cash-nostation-${suffix}`, actor, receiptPrinterId: printerId, cashControlMode: "till" }); } catch (error) { stationlessCashBlocked = error instanceof Error && /payment station/.test(error.message); }
      await sql`ROLLBACK TO SAVEPOINT rejected_cash`;
      if (!stationlessCashBlocked) throw new Error("Cash without a payment station bypassed the register.");
      let closedRegisterBlocked = false;
      try { await commitTender({ orderId, business: "Tiki", tenderType: "cash", amountTenderedCents: 2000, clientMutationId: `cash-closed-${suffix}`, actor, receiptPrinterId: printerId, cashControlMode: "till", stationKey }); } catch (error) { closedRegisterBlocked = error instanceof Error && /Open the register/.test(error.message); }
      await sql`ROLLBACK TO SAVEPOINT rejected_cash`;
      await sql`RELEASE SAVEPOINT rejected_cash`;
      if (!closedRegisterBlocked) throw new Error("Cash was accepted with no open register.");
      // What the cashier's OPEN REGISTER does (the register screen itself is Corner Deli only): an open session on this station's till.
      const tillId = String((await sql`INSERT INTO ordering_pos_terminals(id,business,name,terminal_key,terminal_type,location_label,allow_cash,allow_offline_cash) VALUES(${randomUUID()},'Tiki',${`Payment ${suffix}`},${stationKey},'pos',${`Payment ${suffix}`},TRUE,TRUE) ON CONFLICT(business,terminal_key) DO UPDATE SET active=TRUE RETURNING id`)[0].id);
      await sql`INSERT INTO ordering_register_sessions(id,business,terminal_id,employee_id,status,opening_cash_cents,expected_cash_cents,opened_by,notes) VALUES(${randomUUID()},'Tiki',${tillId},NULL,'open',0,0,${actor.id},'')`;
      const cash = await commitTender({ orderId, business: "Tiki", tenderType: "cash", amountTenderedCents: 2000, clientMutationId: `cash-${suffix}`, actor, receiptPrinterId: printerId, cashControlMode: "till", stationKey });
      const card = await commitTender({ orderId, business: "Tiki", tenderType: "card", amountTenderedCents: 1450, clientMutationId: `card-${suffix}`, actor, providerApproval: { provider: "mx_merchant", transactionReference: `mx-${suffix}` } });
      const cashPayment = cash.tenders.find((row) => row.tender_type === "cash");
      if (!cashPayment) throw new Error("Cash tender was not recorded.");
      await reverseTender({ orderId, business: "Tiki", transactionId: String(cashPayment.id), amountCents: 500, clientMutationId: `refund-${suffix}`, reason: "Station validation refund", actor });
      // A second payment register (no terminal, own till): both can be active, and order-taking checks are routed.
      const backStationId = randomUUID(), backKey = `back-${suffix}`, backPrinterId = randomUUID(), routedOrderId = randomUUID();
      await sql`INSERT INTO ordering_hardware_devices(id,business,location_id,name,device_key,device_type,role,adapter_key,adapter_config,created_by,updated_by) VALUES(${backPrinterId},'Tiki',${locationId},${`Back till ${suffix}`},${`back-till-${suffix}`},'printer','receipt_printer','network-printer',${JSON.stringify({ host: "127.0.0.1", port: 9100, cashDrawerEnabled: true })}::jsonb,${actor.id},${actor.id})`;
      await sql`INSERT INTO ordering_payment_stations(id,business,name,station_key,station_mode,receipt_printer_id,shared_register_key,created_by,updated_by) VALUES(${backStationId},'Tiki',${`Back ${suffix}`},${backKey},'payment',${backPrinterId},${backKey},${actor.id},${actor.id})`;
      await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,total_cents,amount_due_cents) VALUES(${routedOrderId},'Tiki','pos','sent_to_kitchen','unpaid','pickup',${`RT-${suffix}`},${actor.id},'Routed','Test','+13155550198',1200,1200)`;
      const anyRegister = await queueForPayment({ business: "Tiki", orderId: routedOrderId, sourceStationKey: `kitchen-${suffix}`, actor });
      if ((anyRegister as Record<string, unknown>).target_station_key !== "") throw new Error("With two payment registers and no choice, the check should go to any register.");
      const listed = async (key: string) => (await listPaymentQueue("Tiki", key)).some((row) => String(row.order_id) === routedOrderId);
      if (!(await listed(stationKey)) || !(await listed(backKey))) throw new Error("An unrouted check is missing from a payment register's queue.");
      await cancelPaymentQueueEntries("Tiki", routedOrderId);
      await sql`UPDATE ordering_payment_stations SET payment_station_key=${backKey} WHERE id=${orderStationId}`;
      const routed = await queueForPayment({ business: "Tiki", orderId: routedOrderId, sourceStationKey: `kitchen-${suffix}`, actor });
      if ((routed as Record<string, unknown>).target_station_key !== backKey || !(await listed(backKey)) || (await listed(stationKey))) throw new Error("A routed check did not go only to its chosen payment register.");
      await sql`UPDATE ordering_payment_stations SET station_mode='order_taker' WHERE id=${backStationId}`;
      if (!(await listed(stationKey))) throw new Error("A check routed to a register that stopped taking payments disappeared.");
      await sql`UPDATE ordering_payment_stations SET station_mode='payment' WHERE id=${backStationId}`;
      // The back register's cash goes into its own till, not the front one.
      const backTillId = String((await sql`INSERT INTO ordering_pos_terminals(id,business,name,terminal_key,terminal_type,location_label,allow_cash,allow_offline_cash) VALUES(${randomUUID()},'Tiki',${backKey},${backKey},'pos',${`Back ${suffix}`},TRUE,TRUE) RETURNING id`)[0].id);
      const backSession = randomUUID();
      await sql`INSERT INTO ordering_register_sessions(id,business,terminal_id,employee_id,status,opening_cash_cents,expected_cash_cents,opened_by,notes) VALUES(${backSession},'Tiki',${backTillId},NULL,'open',0,0,${actor.id},'')`;
      await commitTender({ orderId: routedOrderId, business: "Tiki", tenderType: "cash", amountTenderedCents: 1200, clientMutationId: `back-cash-${suffix}`, actor, receiptPrinterId: backPrinterId, cashControlMode: "till", stationKey: backKey });
      const backMovements = await sql`SELECT delta_cash_cents FROM ordering_cash_drawer_movements WHERE register_session_id=${backSession}`;
      if (backMovements.length !== 1 || Number(backMovements[0].delta_cash_cents) !== 1200) throw new Error("Back register cash did not land in the back till.");
      const profile = await paymentStationProfile("Tiki", stationKey);
      const queueStatuses = (await sql`SELECT status FROM ordering_payment_station_queue WHERE order_id=${orderId}`).map((row) => String(row.status));
      // NOW() is constant within this transaction, so created_at cannot order
      // the sale and refund. Assert their meanings and tender links instead.
      const movements = await sql`SELECT movement_type,delta_cash_cents,payment_transaction_id FROM ordering_cash_drawer_movements WHERE order_id=${orderId}`;
      assert.deepEqual(movements.map((row) => ({ type: String(row.movement_type), cents: Number(row.delta_cash_cents) })).sort((a,b) => a.type.localeCompare(b.type)), [{ type: "refund", cents: -500 }, { type: "sale", cents: 2000 }], "Cash ledger must contain exactly the sale and refund amounts.");
      assert.equal(String(movements.find((row) => row.movement_type === "sale")?.payment_transaction_id), String(cashPayment.id), "Cash sale must link to the cash tender.");
      const refund = (await sql`SELECT id FROM ordering_payment_transactions WHERE order_id=${orderId} AND client_mutation_id=${`refund-${suffix}`} AND related_transaction_id=${cashPayment.id}`)[0];
      assert.ok(refund, "Cash refund must link to the original tender.");
      assert.equal(String(movements.find((row) => row.movement_type === "refund")?.payment_transaction_id), String(refund.id), "Cash refund movement must link to its reversal.");
      if (profile?.station_mode !== "payment" || !queueStatuses.includes("cancelled") || !queueStatuses.includes("completed") || card.order.payment_status !== "paid") throw new Error("Payment station routing validation failed.");
      Object.assign(result, { closedRegisterBlocked: true, twoPaymentRegisters: true, orderTakerRouting: true, backTillCash: true, orderTakerQueue: true, queueCancellation: true, queueIdempotency: true, checkoutTip: true, stationlessCashBlocked: true, mxProviderLedger: true, cashRegisterLedger: true, cashRefundLedger: true });
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

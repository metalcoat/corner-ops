#!/usr/bin/env node
// Validates POS card sales on an MX terminal against the local MX stand-in
// (scripts/lib/mx-stand-in.ts). Database changes are rolled back; runs
// against the Tiki business, which has no printers on the dev box.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { MX_STAND_IN_OFFLINE_TERMINAL as OFFLINE_TERMINAL, MX_STAND_IN_TERMINAL as TERMINAL, startMxStandIn } from "./lib/mx-stand-in";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("MX terminal validation requires the private local PostgreSQL container.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;
const ROLLBACK = "rollback:mx-terminal-validation";

async function main() {
  const standIn = await startMxStandIn(), mx = standIn.state;
  Object.assign(process.env, standIn.env);
  const { getSql, outsideTransaction, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingHardwareSchema } = await import("../src/lib/ordering-hardware-schema");
  const { hardwareAdapter, saveHardware } = await import("../src/lib/ordering-hardware");
  const { paymentStationProfile } = await import("../src/lib/ordering-payment-stations");
  const { commitTender, reverseTender } = await import("../src/lib/ordering-payments");
  const terminal = await import("../src/lib/mx-terminal-payments");
  const { abandonTerminalPayment, checkTerminalPayment, completeTerminalPayment, startTerminalPayment, settleOpenTerminalSales, listTerminalSalesNeedingReview, resolveTerminalSaleReview, TerminalSaleRecordedError } = terminal;
  const { newTerminalReplayId, mxTerminalState } = await import("../src/lib/mx-terminal");
  const { ensureOrderingGiftCardSchema } = await import("../src/lib/ordering-gift-card-schema");
  // Schema setup runs its DDL outside the test transaction, as payment-station-validate does.
  await ensureOrderingHardwareSchema();
  await ensureOrderingGiftCardSchema();
  const result: Record<string, boolean> = {};
  const business = "Tiki" as const;
  const actor = { id: "mx-terminal-test", name: "MX Terminal Test", type: "employee" as const, role: "manager" as const };
  const cashier = { ...actor, id: "mx-terminal-cashier", role: "employee" as const };
  const orderIds: string[] = [];
  const failure = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { return error; }
    throw new Error("Expected the call to fail.");
  };
  const rejects = async (run: () => Promise<unknown>, pattern: RegExp) => {
    const error = await failure(run);
    assert.match(error instanceof Error ? error.message : String(error), pattern);
    return error;
  };

  for (let i = 0; i < 200; i += 1) assert.match(String(newTerminalReplayId()), /^[1-9]\d{14}$/);
  assert.equal(mxTerminalState("SENTTOTERMINAL"), "pending");
  assert.equal(mxTerminalState("Approved"), "approved");
  assert.equal(mxTerminalState("Cancelled"), "failed");
  result.replayIdsAndStatuses = true;

  try {
    await withTransaction(async () => {
      const sql = getSql(), suffix = randomUUID().slice(0, 8);
      const locationId = randomUUID(), stationKey = `mx-pay-${suffix}`, kitchenStationKey = `mx-kitchen-${suffix}`;
      await sql`INSERT INTO ordering_hardware_locations(id,business,name,location_key) VALUES(${locationId},${business},${`MX ${suffix}`},${`mx-${suffix}`})`;

      // Hardware settings: the MX terminal ID is validated and normalized; the probe reads MX's terminal list.
      await rejects(() => saveHardware({ business, action: "save_device", actor, body: { name: "Bad", deviceKey: `bad-${suffix}`, locationId, deviceType: "payment_terminal", role: "payment_terminal", adapterKey: "mx-terminal", adapterConfig: { mxTerminalId: "11213491" } } }), /MX terminal ID/);
      await rejects(() => saveHardware({ business, action: "save_device", actor, body: { name: "Printer", deviceKey: `p-${suffix}`, locationId, deviceType: "printer", role: "receipt_printer", adapterKey: "mx-terminal", adapterConfig: {} } }), /Unsupported adapter/);
      const { id: terminalDeviceId } = await saveHardware({ business, action: "save_device", actor, body: { name: "Z6", deviceKey: `z6-${suffix}`, locationId, deviceType: "payment_terminal", role: "payment_terminal", adapterKey: "mx-terminal", adapterConfig: { mxTerminalId: TERMINAL.toLowerCase(), junk: "dropped" } } });
      const { id: offlineDeviceId } = await saveHardware({ business, action: "save_device", actor, body: { name: "Unplugged", deviceKey: `z6-off-${suffix}`, locationId, deviceType: "payment_terminal", role: "payment_terminal", adapterKey: "mx-terminal", adapterConfig: { mxTerminalId: OFFLINE_TERMINAL } } });
      assert.deepEqual((await sql`SELECT adapter_config FROM ordering_hardware_devices WHERE id=${terminalDeviceId}`)[0].adapter_config, { mxTerminalId: TERMINAL });
      const probe = (config: Record<string, unknown>) => hardwareAdapter("mx-terminal", "payment_terminal").probe(config);
      assert.match((await probe({ mxTerminalId: TERMINAL })).message, /Registered in MX as Front counter Z6/);
      assert.equal((await probe({ mxTerminalId: OFFLINE_TERMINAL })).status, "offline");
      assert.equal((await probe({ mxTerminalId: "8328D726-911A-4604-AADA-000000000000" })).status, "offline");
      assert.equal((await probe({})).status, "unknown");
      result.hardwareSettings = true;

      // One payment station is allowed per business, so its terminal is swapped as the test goes.
      const stationId = randomUUID(), useTerminal = (deviceId: string | null) => sql`UPDATE ordering_payment_stations SET payment_terminal_id=${deviceId} WHERE id=${stationId}`;
      await sql`INSERT INTO ordering_payment_stations(id,business,name,station_key,station_mode,payment_terminal_id,created_by,updated_by) VALUES
        (${stationId},${business},${`Pay ${suffix}`},${stationKey},'payment',${terminalDeviceId},${actor.id},${actor.id}),
        (${randomUUID()},${business},${`Kitchen ${suffix}`},${kitchenStationKey},'order_taker',${terminalDeviceId},${actor.id},${actor.id})`;
      assert.equal((await paymentStationProfile(business, stationKey))?.mx_terminal_ready, true);
      assert.equal((await paymentStationProfile(business, kitchenStationKey))?.mx_terminal_ready, false, "Only the payment station sends sales to the terminal");
      process.env.MX_TERMINAL_API_ENABLED = "false";
      assert.equal((await paymentStationProfile(business, stationKey))?.mx_terminal_ready, false, "Terminal sales must stay off until MX_TERMINAL_API_ENABLED=true");
      process.env.MX_TERMINAL_API_ENABLED = "true";
      result.stationRouting = true;

      const newOrder = async (totalCents: number) => {
        const id = randomUUID();
        orderIds.push(id);
        await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,subtotal_cents,total_cents,amount_due_cents) VALUES(${id},${business},'pos','sent_to_kitchen','unpaid','pickup',${`MX-${randomUUID().slice(0, 6)}`},${actor.id},'Terminal','Test','+13155550142',${totalCents},${totalCents},${totalCents})`;
        return id;
      };
      const cardTenders = (orderId: string) => sql`SELECT id,amount_cents,provider,provider_transaction_reference,last4,brand,details FROM ordering_payment_transactions WHERE order_id=${orderId} AND tender_type='card' AND transaction_type='payment' ORDER BY created_at`;
      const sessionStatus = async (id: string) => String((await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE id=${id}`)[0]?.status);
      const backdate = (id: string, minutes: number) => sql`UPDATE ordering_mx_checkout_sessions SET created_at=NOW()-make_interval(mins=>${minutes}) WHERE id=${id}`;
      const check = (orderId: string, sessionId: string) => checkTerminalPayment({ business, orderId, actor, sessionId });
      const start = (orderId: string, amountCents?: number) => startTerminalPayment({ business, orderId, stationKey, actor, amountCents });

      // A station without an MX terminal cannot start a terminal sale; nor can an unconnected terminal.
      const orderId = await newOrder(3000);
      await rejects(() => startTerminalPayment({ business, orderId, stationKey: kitchenStationKey, actor }), /must be started from the payment station/);
      await useTerminal(null);
      await rejects(() => start(orderId), /no MX card terminal/);
      await useTerminal(offlineDeviceId);
      await rejects(() => start(orderId), /not connected/);
      await useTerminal(terminalDeviceId);
      assert.equal((await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE order_id=${orderId}`)[0]?.status, "send_failed");
      await rejects(() => start(orderId, 3001), /within the remaining balance/);
      result.refusesUnreadyTerminal = true;

      const complete = (orderId: string, sessionId: string, tipCents: number) => completeTerminalPayment({ business, orderId, actor, sessionId, tipCents });
      const orderRow = async (id: string) => (await sql`SELECT tip_cents,total_cents,payment_status FROM ordering_orders WHERE id=${id}`)[0];

      // The card goes in first: an authorization for the balance, then the tip, then one charge for both.
      mx.next.statuses = ["SENTTOTERMINAL", "SENTTOTERMINAL", "Approved"]; // one poll is used by the busy check below
      const first = await start(orderId, 1000);
      assert.equal(first.state, "pending");
      assert.match(first.state === "pending" ? first.message : "", /can tap, insert, or swipe now/);
      const sent = [...mx.sales.values()].at(-1)!;
      assert.equal(sent.amount, 10);
      assert.equal(sent.terminalId, TERMINAL);
      assert.equal(mx.byReplay.size, 0);
      await rejects(() => start(orderId, 500), /may still charge the card for this order/);
      assert.equal((await check(orderId, first.sessionId)).state, "pending");
      const held = await check(orderId, first.sessionId);
      assert.equal(held.state, "authorized", "An approved card waits for the tip");
      assert.equal((await cardTenders(orderId)).length, 0, "Nothing is recorded until the charge is completed");
      assert.equal((await check(orderId, first.sessionId)).state, "authorized", "Polling again keeps waiting for the tip");
      const charged = await complete(orderId, first.sessionId, 0);
      assert.equal(charged.state, "approved");
      if (charged.state !== "approved") throw new Error("unreachable");
      assert.equal(Number(charged.checkout.order.amount_due_cents), 2000);
      const again = await check(orderId, first.sessionId);
      assert.equal(again.state === "approved" && again.checkout.duplicate, true);
      const tenders = await cardTenders(orderId);
      assert.equal(tenders.length, 1);
      assert.equal(tenders[0].provider, "mx_merchant");
      assert.equal(tenders[0].last4, "4242");
      assert.equal(tenders[0].brand, "Visa");
      assert.equal(tenders[0].details.channel, "pos_terminal");
      assert.equal(tenders[0].details.terminalId, TERMINAL);
      assert.equal(tenders[0].details.entryMode, "Contactless", "Entry mode comes from MX's cardAccount");
      assert.match(String(tenders[0].provider_transaction_reference), /^8000\d\d$/, "The tender references the completed charge");
      assert.match(String(tenders[0].details.authorizationReference), /^9000\d\d$/);
      result.authorizeThenCharge = true;

      // Declined card: nothing recorded, and the cashier can try again right away.
      mx.next.statuses = ["SENTTOTERMINAL", "Declined"];
      const declinedSale = await start(orderId, 500);
      await check(orderId, declinedSale.sessionId);
      const declined = await check(orderId, declinedSale.sessionId);
      assert.equal(declined.state, "declined");
      assert.match(declined.state === "declined" ? declined.message : "", /INSUFFICIENT FUNDS/);
      assert.equal((await cardTenders(orderId)).length, 1);
      result.declineRecordsNothing = true;

      // Cashier stops waiting and reaches for cash; the customer taps anyway. The approved card is charged (no tip) and cash refused.
      mx.next.statuses = ["SENTTOTERMINAL", "Approved"];
      const late = await start(orderId);
      await abandonTerminalPayment({ business, orderId, sessionId: late.sessionId });
      await rejects(() => settleOpenTerminalSales({ business, orderId, actor }), /may still charge the card/); // terminal still prompting
      const recordedError = await failure(() => settleOpenTerminalSales({ business, orderId, actor }));
      assert.ok(recordedError instanceof TerminalSaleRecordedError, "Cash must be refused once the late tap is charged");
      assert.match(recordedError.message, /for \$20\.00 went through/);
      assert.equal(recordedError.checkout.order.payment_status, "paid", "The refusal carries the new balance for the POS");
      assert.equal((await cardTenders(orderId)).length, 2);
      result.otherPaymentsSettleLateTap = true;

      // The next terminal charge resumes an approved card at the tip step instead of charging again.
      const recoverOrder = await newOrder(800);
      mx.next.statuses = ["Approved"];
      const lateAgain = await start(recoverOrder);
      await abandonTerminalPayment({ business, orderId: recoverOrder, sessionId: lateAgain.sessionId });
      const salesBefore = mx.salesSent;
      const resumed = await start(recoverOrder);
      assert.equal(resumed.state, "authorized");
      assert.equal(resumed.sessionId, lateAgain.sessionId);
      assert.equal(mx.salesSent, salesBefore, "A recovered approval must not send another sale");
      assert.equal(resumed.state === "authorized" && resumed.amountCents, 800);
      assert.equal((await complete(recoverOrder, lateAgain.sessionId, 0)).state, "approved");
      await rejects(() => start(recoverOrder), /within the remaining balance/);
      result.terminalChargeResumesApprovedCard = true;

      // MX approved a different amount than the POS sent: held for a manager, shown as final, and blocks further payments.
      const mismatchOrder = await newOrder(1500);
      mx.next.amountOverride = 14;
      const mismatch = await start(mismatchOrder);
      await check(mismatchOrder, mismatch.sessionId);
      const heldForReview = await check(mismatchOrder, mismatch.sessionId);
      assert.equal(heldForReview.state, "needs_review");
      assert.match(heldForReview.state === "needs_review" ? heldForReview.message : "", /approved \$14\.00 but the POS sent \$15\.00/);
      assert.equal(await sessionStatus(mismatch.sessionId), "needs_review");
      assert.equal((await cardTenders(mismatchOrder)).length, 0);
      await rejects(() => settleOpenTerminalSales({ business, orderId: mismatchOrder, actor }), /Mark it resolved/);
      await rejects(() => start(mismatchOrder), /Mark it resolved/);
      assert.ok((await listTerminalSalesNeedingReview(business)).some((row) => row.id === mismatch.sessionId));
      await rejects(() => resolveTerminalSaleReview({ business, sessionId: mismatch.sessionId, note: "Voided in MX", actor: cashier }), /Only a manager/);
      await rejects(() => resolveTerminalSaleReview({ business, sessionId: mismatch.sessionId, note: " ", actor }), /Say what was done/);
      await resolveTerminalSaleReview({ business, sessionId: mismatch.sessionId, note: "Voided in MX", actor });
      assert.equal(await sessionStatus(mismatch.sessionId), "resolved");
      assert.ok(!(await listTerminalSalesNeedingReview(business)).some((row) => row.id === mismatch.sessionId));
      await settleOpenTerminalSales({ business, orderId: mismatchOrder, actor });
      result.amountMismatchHeldForManager = true;

      // Order paid some other way before the tip was chosen: nothing is left to pay, so the hold is released, not charged.
      const paidElsewhere = await newOrder(1200);
      const pending = await start(paidElsewhere);
      await check(paidElsewhere, pending.sessionId);
      assert.equal((await check(paidElsewhere, pending.sessionId)).state, "authorized");
      await commitTender({ orderId: paidElsewhere, business, tenderType: "card", amountTenderedCents: 1200, clientMutationId: `other-${suffix}`, actor, providerApproval: { provider: "test", transactionReference: `other-${suffix}` } });
      const releasedInstead = await complete(paidElsewhere, pending.sessionId, 0);
      assert.equal(releasedInstead.state, "failed");
      assert.match(releasedInstead.state === "failed" ? releasedInstead.message : "", /nothing left to pay.*released/);
      assert.equal(await sessionStatus(pending.sessionId), "voided");
      assert.equal((await cardTenders(paidElsewhere)).filter((row) => row.provider === "mx_merchant").length, 0);
      result.paidElsewhereReleasesHold = true;

      // An item was removed after the card was approved: only the new balance (plus tip) is charged.
      const shrunk = await newOrder(1500);
      const shrunkSale = await start(shrunk);
      await check(shrunk, shrunkSale.sessionId);
      assert.equal((await check(shrunk, shrunkSale.sessionId)).state, "authorized");
      await sql`UPDATE ordering_orders SET subtotal_cents=1000,total_cents=1000,amount_due_cents=1000 WHERE id=${shrunk}`;
      assert.equal((await complete(shrunk, shrunkSale.sessionId, 100)).state, "approved");
      assert.deepEqual({ amount: mx.completions.at(-1)!.amount, tip: mx.completions.at(-1)!.tip }, { amount: "11.00", tip: "1.00" });
      assert.deepEqual({ ...(await orderRow(shrunk)) }, { tip_cents: 100, total_cents: 1100, payment_status: "paid" });
      result.smallerBalanceChargedNotHold = true;

      // The charge cannot be put on the order (here: its payment request ID is already taken): flagged for a manager, never dropped.
      const tipRefused = await newOrder(1000), elsewhere = await newOrder(500);
      const tipRefusedSale = await start(tipRefused);
      await check(tipRefused, tipRefusedSale.sessionId);
      await check(tipRefused, tipRefusedSale.sessionId);
      const takenId = String((await sql`SELECT client_mutation_id FROM ordering_mx_checkout_sessions WHERE id=${tipRefusedSale.sessionId}`)[0].client_mutation_id);
      await commitTender({ orderId: elsewhere, business, tenderType: "card", amountTenderedCents: 500, clientMutationId: takenId, actor, providerApproval: { provider: "test", transactionReference: `taken-${suffix}` } });
      const flagged = await complete(tipRefused, tipRefusedSale.sessionId, 0);
      assert.equal(flagged.state, "needs_review");
      assert.match(flagged.state === "needs_review" ? flagged.message : "", /charged the card \$10\.00.*manager must refund MX payment \d+/);
      result.unrecordableChargeFlagged = true;

      // Tip chosen after the card: one charge for balance + tip, the tip lands on the order once.
      const tipOrder = await newOrder(2000);
      const tipped = await start(tipOrder);
      await check(tipOrder, tipped.sessionId);
      assert.equal((await check(tipOrder, tipped.sessionId)).state, "authorized");
      const completionsBefore = mx.completions.length;
      assert.equal((await complete(tipOrder, tipped.sessionId, 300)).state, "approved");
      assert.equal(mx.completions.length, completionsBefore + 1);
      assert.deepEqual({ amount: mx.completions.at(-1)!.amount, tip: mx.completions.at(-1)!.tip }, { amount: "23.00", tip: "3.00" });
      assert.deepEqual({ ...(await orderRow(tipOrder)) }, { tip_cents: 300, total_cents: 2300, payment_status: "paid" });
      assert.equal(Number((await cardTenders(tipOrder))[0].amount_cents), 2300);
      // The session update after recording is lost and the completion is resumed: no second charge, tip, or tender.
      await sql`UPDATE ordering_mx_checkout_sessions SET status='completing',completion_started_at=NOW()-INTERVAL '2 minutes' WHERE id=${tipped.sessionId}`;
      const replay = await check(tipOrder, tipped.sessionId);
      assert.equal(replay.state === "approved" && replay.checkout.duplicate, true);
      assert.equal(mx.completions.length, completionsBefore + 1, "A resumed completion is looked up, not sent again");
      assert.equal(Number((await orderRow(tipOrder)).tip_cents), 300);
      assert.equal((await cardTenders(tipOrder)).length, 1);
      result.tipAfterCardChargedOnce = true;

      // MX declines the amount with the tip: back to the tip step, and a smaller tip goes through.
      const tipDecline = await newOrder(1000);
      const tipDeclineSale = await start(tipDecline);
      await check(tipDecline, tipDeclineSale.sessionId);
      await check(tipDecline, tipDeclineSale.sessionId);
      mx.nextCompletion = "decline";
      const backToTip = await complete(tipDecline, tipDeclineSale.sessionId, 5000);
      assert.equal(backToTip.state, "authorized");
      assert.match(backToTip.state === "authorized" ? backToTip.message : "", /did not accept \$60\.00 with the tip.*Choose a different tip/);
      assert.equal(Number((await orderRow(tipDecline)).tip_cents), 0);
      assert.equal((await complete(tipDecline, tipDeclineSale.sessionId, 150)).state, "approved");
      assert.equal(Number((await orderRow(tipDecline)).tip_cents), 150);
      result.declinedTipReturnsToTipStep = true;

      // MX's answer to the completion is lost: the POS keeps checking, then finds the charge instead of charging again.
      const lostCapture = await newOrder(1100);
      const lostCaptureSale = await start(lostCapture);
      await check(lostCapture, lostCaptureSale.sessionId);
      await check(lostCapture, lostCaptureSale.sessionId);
      mx.nextCompletion = "gateway-after-capture";
      const capturing = await complete(lostCapture, lostCaptureSale.sessionId, 0);
      assert.equal(capturing.state, "pending");
      assert.equal(await sessionStatus(lostCaptureSale.sessionId), "completing");
      assert.equal((await check(lostCapture, lostCaptureSale.sessionId)).state, "pending", "A completion in flight is not sent twice");
      await rejects(() => settleOpenTerminalSales({ business, orderId: lostCapture, actor }), /may still charge the card/);
      const sentCompletions = mx.completions.length;
      await sql`UPDATE ordering_mx_checkout_sessions SET completion_started_at=NOW()-INTERVAL '2 minutes' WHERE id=${lostCaptureSale.sessionId}`;
      assert.equal((await check(lostCapture, lostCaptureSale.sessionId)).state, "approved");
      assert.equal(mx.completions.length, sentCompletions, "The lost completion was found by replayId");
      assert.equal((await cardTenders(lostCapture)).length, 1);
      result.lostCompletionAnswerRecovered = true;

      // A completion MX already took, but the lookup misses it: the resend is refused, and the POS does not ask for a tip again.
      const consumed = await newOrder(1000);
      const consumedSale = await start(consumed);
      await check(consumed, consumedSale.sessionId);
      await check(consumed, consumedSale.sessionId);
      mx.nextCompletion = "gateway-after-capture";
      await complete(consumed, consumedSale.sessionId, 0);
      const consumedRow = (await sql`SELECT completion_replay_id FROM ordering_mx_checkout_sessions WHERE id=${consumedSale.sessionId}`)[0];
      mx.byReplay.delete(String(Number(consumedRow.completion_replay_id))); // MX has the charge, but the replayId lookup does not show it
      await sql`UPDATE ordering_mx_checkout_sessions SET completion_started_at=NOW()-INTERVAL '2 minutes' WHERE id=${consumedSale.sessionId}`;
      const notAskedAgain = await check(consumed, consumedSale.sessionId);
      assert.equal(notAskedAgain.state, "needs_review", "A used-up authorization is never sent back to the tip step");
      assert.match(notAskedAgain.state === "needs_review" ? notAskedAgain.message : "", /already charged this card/);
      result.usedUpAuthorizationNotRetried = true;

      // The customer changes their mind after the card was approved: the hold is released, nothing is charged.
      const released = await newOrder(1300);
      const releasedSale = await start(released);
      await check(released, releasedSale.sessionId);
      await check(released, releasedSale.sessionId);
      await terminal.voidTerminalAuthorization({ business, orderId: released, sessionId: releasedSale.sessionId });
      assert.equal(await sessionStatus(releasedSale.sessionId), "voided");
      const releasedReplay = String((await sql`SELECT replay_id FROM ordering_mx_checkout_sessions WHERE id=${releasedSale.sessionId}`)[0].replay_id);
      assert.equal(mx.byReplay.get(String(Number(releasedReplay)))?.status, "Voided", "The authorization is voided at MX");
      await rejects(() => terminal.voidTerminalAuthorization({ business, orderId: released, sessionId: releasedSale.sessionId }), /Only an approved card/);
      await settleOpenTerminalSales({ business, orderId: released, actor });
      assert.equal((await cardTenders(released)).length, 0);
      result.approvedCardReleased = true;

      // Nobody answered the tip question: the sweep charges the card without a tip so the hold never lapses.
      const forgotten = await newOrder(1400);
      const forgottenSale = await start(forgotten);
      await check(forgotten, forgottenSale.sessionId);
      await check(forgotten, forgottenSale.sessionId);
      assert.deepEqual(await terminal.captureStaleTerminalAuthorizations(business), { captured: 0 }, "A fresh approval still waits for its tip");
      await sql`UPDATE ordering_mx_checkout_sessions SET authorized_at=NOW()-INTERVAL '11 minutes' WHERE id=${forgottenSale.sessionId}`;
      assert.deepEqual(await terminal.captureStaleTerminalAuthorizations(business), { captured: 1 });
      assert.deepEqual({ ...(await orderRow(forgotten)) }, { tip_cents: 0, total_cents: 1400, payment_status: "paid" });
      assert.equal((await cardTenders(forgotten))[0].details.tipCents, 0);
      result.forgottenTipCapturedBySweep = true;

      // MX's answer to the send is lost after the sale reached the terminal: found by replayId, not charged twice.
      const lostAnswer = await newOrder(900);
      mx.next.mode = "gateway-after-accept";
      const unsure = await start(lostAnswer);
      assert.equal(unsure.state, "pending");
      assert.match(unsure.state === "pending" ? unsure.message : "", /not responding.*the POS is checking with MX/);
      assert.equal(await sessionStatus(unsure.sessionId), "send_unknown");
      assert.equal((await check(lostAnswer, unsure.sessionId)).state, "authorized");
      assert.equal((await complete(lostAnswer, unsure.sessionId, 0)).state, "approved");
      assert.equal((await cardTenders(lostAnswer)).length, 1);
      result.lostSendAnswerRecovered = true;

      // The sale never reached the terminal: other payments wait out the prompt window, then it is closed as not charged.
      const neverSent = await newOrder(700);
      mx.next.mode = "gateway-no-sale";
      const ghost = await start(neverSent);
      assert.equal((await check(neverSent, ghost.sessionId)).state, "pending");
      await rejects(() => settleOpenTerminalSales({ business, orderId: neverSent, actor }), /may still charge the card/);
      await backdate(ghost.sessionId, 4);
      await settleOpenTerminalSales({ business, orderId: neverSent, actor });
      await backdate(ghost.sessionId, 11);
      const closed = await check(neverSent, ghost.sessionId);
      assert.equal(closed.state, "failed");
      assert.match(closed.state === "failed" ? closed.message : "", /MX has no payment/);
      result.lostSendClosedAfterWindow = true;

      // A request that died mid-send leaves 'sending'; it is rechecked as unknown rather than skipped.
      const crashed = await newOrder(600), crashedId = randomUUID();
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,status,channel,station_key,terminal_id,created_by,expires_at,created_at)
        VALUES(${crashedId},${business},${crashed},600,${newTerminalReplayId()},${randomUUID()},'sending','terminal',${stationKey},${OFFLINE_TERMINAL},${actor.id},NOW()+INTERVAL '30 minutes',NOW()-INTERVAL '2 minutes')`;
      assert.equal((await check(crashed, crashedId)).state, "pending");
      assert.equal(await sessionStatus(crashedId), "send_unknown");
      result.staleSendingRechecked = true;

      // One sale per terminal: another order waits while the terminal is prompting, and the database enforces it.
      const busyOrder = await newOrder(500), waitingOrder = await newOrder(400);
      mx.next.statuses = ["SENTTOTERMINAL"];
      const busy = await start(busyOrder);
      const busyNumber = String((await sql`SELECT display_number FROM ordering_orders WHERE id=${busyOrder}`)[0].display_number);
      await rejects(() => start(waitingOrder), new RegExp(`still showing the card sale for order #${busyNumber}`));
      await backdate(busy.sessionId, 4);
      const afterBusy = await start(waitingOrder);
      assert.equal(afterBusy.state, "pending");
      assert.equal(await sessionStatus(busy.sessionId), "abandoned", "A sale past the prompt window stops holding the terminal but stays on record");
      await sql`SAVEPOINT one_active`;
      const duplicate = await failure(() => sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,status,channel,terminal_id,created_by,expires_at)
        VALUES(${randomUUID()},${business},${busyOrder},100,${newTerminalReplayId()},${randomUUID()},'sent','terminal',${TERMINAL},${actor.id},NOW())`);
      await sql`ROLLBACK TO SAVEPOINT one_active`;
      assert.equal((duplicate as { code?: string }).code, "23505");
      result.oneSalePerTerminal = true;

      // A terminal payment refunds through MX like a keyed one (full reversal before settlement is a void).
      const tipTender = (await cardTenders(tipOrder))[0];
      const reversal = await reverseTender({ orderId: tipOrder, business, transactionId: String(tipTender.id), amountCents: 2300, clientMutationId: `void-${suffix}`, reason: "Terminal validation void", actor });
      assert.ok(reversal.tenders.some((row: any) => row.transaction_type === "void" && Number(row.amount_cents) === 2300));
      assert.equal(mx.byId.get(String(tipTender.provider_transaction_reference))?.status, "Voided");
      assert.equal(mx.byId.get(String(tipTender.details.authorizationReference))?.status, "Voided", "Voiding the charge also releases the hold it completed");
      result.terminalPaymentVoids = true;

      assert.equal(mx.tokenRequests, 1, "The terminal JWT should be reused until it nears expiry");
      result.jwtCached = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  } finally {
    await standIn.close();
    // Refund attempts are logged outside the order transaction on purpose; remove this run's.
    if (orderIds.length) await outsideTransaction(() => getSql()`DELETE FROM ordering_mx_reversal_attempts WHERE order_id = ANY(${orderIds}::uuid[])`).catch(() => {});
  }
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => { console.error(error); process.exit(1); });

#!/usr/bin/env node
// Validates POS card sales on an MX terminal against a local stand-in for the
// MX security, terminal, and checkout APIs. Responses mirror what the real MX
// sandbox returned on 2026-10-04 (GUID terminal ids, bare-string errors such
// as "The terminal is not connected"). Database changes are rolled back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("MX terminal validation requires the private local PostgreSQL container.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;
const ROLLBACK = "rollback:mx-terminal-validation";

const MERCHANT = "424242", TERMINAL = "8328D726-911A-4604-AADA-FF08091A4EDE", OFFLINE_TERMINAL = "C95835C8-356D-4526-999D-B5816309BC04";
type Sale = { terminalId: string; amount: number; replayId: string; statuses: string[]; payment: Record<string, unknown> };
const mx = {
  tokenRequests: 0,
  salesSent: 0,
  sales: new Map<string, Sale>(),
  /** Next sale's poll statuses (the last one repeats) and the payment MX would report. */
  next: { statuses: ["SENTTOTERMINAL", "Approved"], amountOverride: null as number | null, last4: "4242" },
  payments: new Map<string, Record<string, unknown>>(),
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://mx.local"), path = url.pathname;
  if (path === `/security/v1/application/merchantId/${MERCHANT}/token`) {
    assert.match(String(req.headers.authorization), /^Basic /);
    mx.tokenRequests += 1;
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
    return send(res, 200, { processorName: "TSYS", jwtToken: `e30.${payload}.sig` });
  }
  if (path.startsWith("/terminal/") && !String(req.headers.authorization).startsWith("Bearer e30.")) return send(res, 401, "Unauthorized");
  if (path === `/terminal/v1/merchantid/${MERCHANT}`)
    return send(res, 200, [
      { id: TERMINAL, iid: 1, name: "Front counter Z6", providerKey: "dejavoo", enabled: true, deleted: null, uniqueIdentifier: "1" },
      { id: OFFLINE_TERMINAL, iid: 2, name: "Old terminal", providerKey: "dejavoo", enabled: false, deleted: null, uniqueIdentifier: "2" },
    ]);
  const create = path.match(/^\/terminal\/v1\/transaction\/merchantid\/(\d+)\/terminalid\/([^/]+)$/);
  if (create && req.method === "POST") {
    const body = await readBody(req);
    if (!/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(create[2])) return send(res, 400, { message: "Validation errors" });
    if (create[2] === OFFLINE_TERMINAL) return send(res, 500, "Transaction was not created, because: The transaction was not sent to the terminal, because: The terminal is not connected");
    assert.equal(body.type, "Sale");
    assert.match(String(body.replayId), /^\d{15}$/, "Terminal replayId must be a 15-digit string");
    assert.equal(typeof body.amount, "number");
    mx.salesSent += 1;
    const id = randomUUID().toUpperCase(), amount = mx.next.amountOverride ?? body.amount;
    mx.sales.set(id, { terminalId: create[2], amount: body.amount, replayId: body.replayId, statuses: [...mx.next.statuses], payment: { id: 900000 + mx.salesSent, status: "Approved", amount: amount.toFixed(2), authCode: "OK1234", entryMode: "Contactless", cardAccount: { cardType: "Visa", last4: mx.next.last4 } } });
    mx.next = { statuses: ["SENTTOTERMINAL", "Approved"], amountOverride: null, last4: "4242" };
    return send(res, 200, { message: "A transaction was sent to the terminal.", prioritypaymentsystems: { mxmerchant: { merchant: { devicePaymentAuditId: id }, transaction: {} } }, provider: { key: "dejavoo", name: "Dejavoo", transaction: { message: "A transaction was sent to the terminal." } }, status: "SENTTOTERMINAL" });
  }
  const status = path.match(/^\/terminal\/v1\/transaction\/merchantid\/(\d+)\/transactionid\/([^/]+)$/);
  if (status) {
    const sale = mx.sales.get(status[2]);
    if (!sale) return send(res, 500, "The provided merchant id does not match the transaction.");
    const current = sale.statuses.length > 1 ? sale.statuses.shift()! : sale.statuses[0];
    if (current.toLowerCase() === "approved") mx.payments.set(String(Number(sale.replayId)), sale.payment);
    return send(res, 200, { status: current, message: current === "Declined" ? "DECLINED - INSUFFICIENT FUNDS" : "" });
  }
  if (path === "/checkout/v3/payment" && url.searchParams.get("merchantId") === MERCHANT) {
    const payment = mx.payments.get(String(Number(url.searchParams.get("replayId"))));
    return payment ? send(res, 200, payment) : send(res, 400, { message: "Not found" });
  }
  send(res, 404, { message: `stand-in has no route for ${req.method} ${path}` });
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    PAYMENT_PROVIDER: "mx_merchant", MX_ENVIRONMENT: "sandbox", MX_MERCHANT_ID: MERCHANT, MX_CONSUMER_KEY: "stand-in-key", MX_CONSUMER_SECRET: "stand-in-secret", MX_BUSINESS_ID: "stand-in",
    MX_TERMINAL_API_ENABLED: "true", MX_TEST_API_BASE_URL: `${base}/checkout/v3`, MX_TEST_TERMINAL_API_BASE_URL: base,
  });
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingHardwareSchema } = await import("../src/lib/ordering-hardware-schema");
  const { hardwareAdapter, saveHardware } = await import("../src/lib/ordering-hardware");
  const { paymentStationProfile } = await import("../src/lib/ordering-payment-stations");
  const { commitTender } = await import("../src/lib/ordering-payments");
  const { abandonTerminalPayment, checkTerminalPayment, startTerminalPayment } = await import("../src/lib/mx-terminal-payments");
  const { newTerminalReplayId, mxTerminalState } = await import("../src/lib/mx-terminal");
  await ensureOrderingHardwareSchema();
  const result: Record<string, boolean> = {};
  // Tiki: the dev database already has Corner Deli's one allowed payment station.
  const business = "Tiki" as const;
  const actor = { id: "mx-terminal-test", name: "MX Terminal Test", type: "employee" as const, role: "manager" as const };
  const rejects = async (run: () => Promise<unknown>, pattern: RegExp) => {
    let message = "";
    try { await run(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    assert.match(message, pattern);
  };

  for (let i = 0; i < 200; i += 1) assert.match(String(newTerminalReplayId()), /^[1-9]\d{14}$/);
  assert.equal(mxTerminalState("SENTTOTERMINAL"), "pending");
  assert.equal(mxTerminalState("Approved"), "approved");
  assert.equal(mxTerminalState("Cancelled"), "failed");
  result.replayIdsAndStatuses = true;

  try {
    await withTransaction(async () => {
      const sql = getSql(), suffix = randomUUID().slice(0, 8);
      const locationId = randomUUID(), stationKey = `mx-pay-${suffix}`, keyedStationKey = `mx-keyed-${suffix}`;
      await sql`INSERT INTO ordering_hardware_locations(id,business,name,location_key) VALUES(${locationId},${business},${`MX ${suffix}`},${`mx-${suffix}`})`;

      // Hardware settings: the MX terminal ID is validated and normalized; the probe reads MX's terminal list.
      await rejects(() => saveHardware({ business, action: "save_device", actor, body: { name: "Bad", deviceKey: `bad-${suffix}`, locationId, deviceType: "payment_terminal", role: "payment_terminal", adapterKey: "mx-terminal", adapterConfig: { mxTerminalId: "11213491" } } }), /MX terminal ID/);
      await rejects(() => saveHardware({ business, action: "save_device", actor, body: { name: "Printer", deviceKey: `p-${suffix}`, locationId, deviceType: "printer", role: "receipt_printer", adapterKey: "mx-terminal", adapterConfig: {} } }), /Unsupported adapter/);
      const { id: terminalDeviceId } = await saveHardware({ business, action: "save_device", actor, body: { name: "Z6", deviceKey: `z6-${suffix}`, locationId, deviceType: "payment_terminal", role: "payment_terminal", adapterKey: "mx-terminal", adapterConfig: { mxTerminalId: TERMINAL.toLowerCase(), junk: "dropped" } } });
      const { id: offlineDeviceId } = await saveHardware({ business, action: "save_device", actor, body: { name: "Unplugged", deviceKey: `z6-off-${suffix}`, locationId, deviceType: "payment_terminal", role: "payment_terminal", adapterKey: "mx-terminal", adapterConfig: { mxTerminalId: OFFLINE_TERMINAL } } });
      const saved = (await sql`SELECT adapter_config FROM ordering_hardware_devices WHERE id=${terminalDeviceId}`)[0];
      assert.deepEqual(saved.adapter_config, { mxTerminalId: TERMINAL });
      const probe = await hardwareAdapter("mx-terminal", "payment_terminal").probe({ mxTerminalId: TERMINAL });
      assert.match(probe.message, /Registered in MX as Front counter Z6/);
      assert.equal((await hardwareAdapter("mx-terminal", "payment_terminal").probe({ mxTerminalId: OFFLINE_TERMINAL })).status, "offline");
      assert.equal((await hardwareAdapter("mx-terminal", "payment_terminal").probe({ mxTerminalId: "8328D726-911A-4604-AADA-000000000000" })).status, "offline");
      assert.equal((await hardwareAdapter("mx-terminal", "payment_terminal").probe({})).status, "unknown");
      result.hardwareSettings = true;

      // One payment station is allowed per business, so its terminal is swapped as the test goes.
      const stationId = randomUUID(), useTerminal = (deviceId: string | null) => sql`UPDATE ordering_payment_stations SET payment_terminal_id=${deviceId} WHERE id=${stationId}`;
      await sql`INSERT INTO ordering_payment_stations(id,business,name,station_key,station_mode,payment_terminal_id,created_by,updated_by) VALUES
        (${stationId},${business},${`Pay ${suffix}`},${stationKey},'payment',${terminalDeviceId},${actor.id},${actor.id}),
        (${randomUUID()},${business},${`Kitchen ${suffix}`},${keyedStationKey},'order_taker',${terminalDeviceId},${actor.id},${actor.id})`;
      assert.equal((await paymentStationProfile(business, stationKey))?.mx_terminal_ready, true);
      assert.equal((await paymentStationProfile(business, keyedStationKey))?.mx_terminal_ready, false, "Only the payment station sends sales to the terminal");
      process.env.MX_TERMINAL_API_ENABLED = "false";
      assert.equal((await paymentStationProfile(business, stationKey))?.mx_terminal_ready, false, "Terminal sales must stay off until MX_TERMINAL_API_ENABLED=true");
      process.env.MX_TERMINAL_API_ENABLED = "true";
      result.stationRouting = true;

      const newOrder = async (totalCents: number) => {
        const id = randomUUID();
        await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,total_cents,amount_due_cents) VALUES(${id},${business},'pos','sent_to_kitchen','unpaid','pickup',${`MX-${randomUUID().slice(0, 6)}`},${actor.id},'Terminal','Test','+13155550142',${totalCents},${totalCents})`;
        return id;
      };
      const cardTenders = async (orderId: string) => sql`SELECT amount_cents,provider,provider_transaction_reference,last4,brand,details FROM ordering_payment_transactions WHERE order_id=${orderId} AND tender_type='card' AND transaction_type='payment'`;

      // A station without an MX terminal cannot start a terminal sale; nor can an unconnected terminal.
      const orderId = await newOrder(3000);
      await rejects(() => startTerminalPayment({ business, orderId, stationKey: keyedStationKey, actor }), /must be started from the payment station/);
      await useTerminal(null);
      await rejects(() => startTerminalPayment({ business, orderId, stationKey, actor }), /no MX card terminal/);
      await useTerminal(offlineDeviceId);
      await rejects(() => startTerminalPayment({ business, orderId, stationKey, actor }), /not connected/);
      await useTerminal(terminalDeviceId);
      assert.equal((await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE order_id=${orderId}`)[0]?.status, "send_failed");
      await rejects(() => startTerminalPayment({ business, orderId, stationKey, actor, amountCents: 3001 }), /within the remaining balance/);
      result.refusesUnreadyTerminal = true;

      // Partial sale: pending while the customer taps, then approved and recorded once.
      mx.next.statuses = ["SENTTOTERMINAL", "SENTTOTERMINAL", "Approved"]; // one poll is used by the busy-terminal check below
      const first = await startTerminalPayment({ business, orderId, stationKey, actor, amountCents: 1000 });
      assert.equal(first.state, "pending");
      const sent = [...mx.sales.values()].at(-1)!;
      assert.equal(sent.amount, 10);
      assert.equal(sent.terminalId, TERMINAL);
      await rejects(() => startTerminalPayment({ business, orderId, stationKey, actor, amountCents: 500 }), /still waiting for a card/);
      assert.equal((await checkTerminalPayment({ business, orderId, actor, sessionId: first.sessionId })).state, "pending");
      const approved = await checkTerminalPayment({ business, orderId, actor, sessionId: first.sessionId });
      assert.equal(approved.state, "approved");
      if (approved.state !== "approved") throw new Error("unreachable");
      assert.equal(Number(approved.checkout.order.amount_due_cents), 2000);
      const again = await checkTerminalPayment({ business, orderId, actor, sessionId: first.sessionId });
      assert.equal(again.state === "approved" && again.checkout.duplicate, true);
      const tenders = await cardTenders(orderId);
      assert.equal(tenders.length, 1);
      assert.equal(tenders[0].provider, "mx_merchant");
      assert.equal(tenders[0].last4, "4242");
      assert.equal(tenders[0].brand, "Visa");
      assert.equal(tenders[0].details.channel, "pos_terminal");
      assert.equal(tenders[0].details.terminalId, TERMINAL);
      assert.match(String(tenders[0].provider_transaction_reference), /^9000\d\d$/);
      result.partialSaleApprovedOnce = true;

      // Declined card: nothing recorded, and the cashier can try again right away.
      mx.next.statuses = ["SENTTOTERMINAL", "Declined"];
      const declinedSale = await startTerminalPayment({ business, orderId, stationKey, actor, amountCents: 500 });
      await checkTerminalPayment({ business, orderId, actor, sessionId: declinedSale.sessionId });
      const declined = await checkTerminalPayment({ business, orderId, actor, sessionId: declinedSale.sessionId });
      assert.equal(declined.state, "declined");
      assert.match(declined.state === "declined" ? declined.message : "", /INSUFFICIENT FUNDS/);
      assert.equal((await cardTenders(orderId)).length, 1);
      result.declineRecordsNothing = true;

      // Cashier stops waiting, the customer taps anyway: the next charge finds and records it instead of charging twice.
      mx.next.statuses = ["SENTTOTERMINAL", "Approved"];
      const late = await startTerminalPayment({ business, orderId, stationKey, actor });
      await abandonTerminalPayment({ business, orderId, sessionId: late.sessionId });
      const salesBefore = mx.salesSent;
      await checkTerminalPayment({ business, orderId, actor, sessionId: late.sessionId }); // terminal still prompting
      const recovered = await startTerminalPayment({ business, orderId, stationKey, actor });
      assert.equal(recovered.state, "approved");
      assert.equal(recovered.sessionId, late.sessionId);
      assert.equal(mx.salesSent, salesBefore, "A recovered approval must not send another sale");
      assert.equal(recovered.state === "approved" && recovered.checkout.order.payment_status, "paid");
      assert.equal((await cardTenders(orderId)).length, 2);
      await rejects(() => startTerminalPayment({ business, orderId, stationKey, actor }), /no remaining balance|within the remaining balance/);
      result.lateApprovalRecovered = true;

      // MX reports a different amount than the POS sent: held for a manager, not recorded.
      const mismatchOrder = await newOrder(1500);
      mx.next.amountOverride = 14;
      const mismatch = await startTerminalPayment({ business, orderId: mismatchOrder, stationKey, actor });
      await checkTerminalPayment({ business, orderId: mismatchOrder, actor, sessionId: mismatch.sessionId });
      await rejects(() => checkTerminalPayment({ business, orderId: mismatchOrder, actor, sessionId: mismatch.sessionId }), /does not match/);
      assert.equal((await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE id=${mismatch.sessionId}`)[0].status, "needs_review");
      assert.equal((await cardTenders(mismatchOrder)).length, 0);
      result.amountMismatchHeld = true;

      // Order paid some other way while the terminal was prompting: the charge is flagged, never dropped silently.
      const paidElsewhere = await newOrder(1200);
      const pending = await startTerminalPayment({ business, orderId: paidElsewhere, stationKey, actor });
      await commitTender({ orderId: paidElsewhere, business, tenderType: "card", amountTenderedCents: 1200, clientMutationId: `other-${suffix}`, actor, providerApproval: { provider: "test", transactionReference: `other-${suffix}` } });
      await checkTerminalPayment({ business, orderId: paidElsewhere, actor, sessionId: pending.sessionId });
      await rejects(() => checkTerminalPayment({ business, orderId: paidElsewhere, actor, sessionId: pending.sessionId }), /charged the card \$12\.00.*manager must refund MX payment/);
      assert.equal((await sql`SELECT status FROM ordering_mx_checkout_sessions WHERE id=${pending.sessionId}`)[0].status, "needs_review");
      result.paidElsewhereFlagged = true;

      assert.equal(mx.tokenRequests, 1, "The terminal JWT should be reused until it nears expiry");
      result.jwtCached = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  } finally {
    server.close();
  }
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => { console.error(error); process.exit(1); });

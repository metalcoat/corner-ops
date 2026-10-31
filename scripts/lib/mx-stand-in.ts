// A local stand-in for the MX security, terminal, and checkout APIs, used by
// the terminal tests. Responses mirror what the real MX sandbox returned on
// 2026-10-04: GUID terminal ids, bare-string errors such as "The terminal is
// not connected", 404 for an unknown replayId, and `tip` included in `amount`.
//
// Tests script the next sale through `state.next` in process, or with
// POST /__stand-in/next from another process (the e2e browser test).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const MX_STAND_IN_MERCHANT = "424242";
export const MX_STAND_IN_TERMINAL = "8328D726-911A-4604-AADA-FF08091A4EDE";
/** Registered but disabled, and answers every sale with "not connected". */
export const MX_STAND_IN_OFFLINE_TERMINAL = "C95835C8-356D-4526-999D-B5816309BC04";

export type StandInMode = "normal" | "gateway-after-accept" | "gateway-no-sale";
export type StandInNext = { statuses: string[]; amountOverride: number | null; tip: number; mode: StandInMode };
/** How the next completion of an authorization is answered. */
export type StandInCompletion = "approve" | "decline" | "gateway-after-capture";
type Sale = { terminalId: string; amount: number; replayId: string; statuses: string[]; payment: Record<string, unknown> };

const fresh = (): StandInNext => ({ statuses: ["SENTTOTERMINAL", "Approved"], amountOverride: null, tip: 0, mode: "normal" });

export async function startMxStandIn(port = 0) {
  const state = {
    tokenRequests: 0,
    salesSent: 0,
    sales: new Map<string, Sale>(),
    /** Next sale's poll statuses (the last one repeats), amount/tip MX reports, and how the send is answered. */
    next: fresh(),
    nextCompletion: "approve" as StandInCompletion,
    completions: [] as Record<string, unknown>[],
    byReplay: new Map<string, Record<string, unknown>>(),
    byId: new Map<string, Record<string, unknown>>(),
  };
  const post = (payment: Record<string, unknown>, replayId: string) => {
    state.byReplay.set(String(Number(replayId)), payment);
    state.byId.set(String(payment.id), payment);
  };
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : {};
  };
  const M = MX_STAND_IN_MERCHANT;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://mx.local"), path = url.pathname;
      if (path === "/__stand-in/next" && req.method === "POST") {
        const body = await readBody(req);
        state.next = { ...fresh(), ...body };
        if (body.completion) state.nextCompletion = body.completion;
        return send(res, 200, state.next);
      }
      // The customer or cashier pressed the red X: every sale still prompting ends as cancelled.
      if (path === "/__stand-in/cancel-pending" && req.method === "POST") {
        for (const sale of state.sales.values()) if (!/approved|declined/i.test(sale.statuses.at(-1) || "")) sale.statuses = ["Cancelled"];
        return send(res, 200, {});
      }
      if (path === "/__stand-in/state") return send(res, 200, { salesSent: state.salesSent, tokenRequests: state.tokenRequests, completions: state.completions });
      if (path === `/security/v1/application/merchantId/${M}/token`) {
        if (!String(req.headers.authorization).startsWith("Basic ")) return send(res, 401, "Unauthorized");
        state.tokenRequests += 1;
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
        return send(res, 200, { processorName: "TSYS", jwtToken: `e30.${payload}.sig` });
      }
      if (path.startsWith("/terminal/") && !String(req.headers.authorization).startsWith("Bearer e30.")) return send(res, 401, "Unauthorized");
      if (path === `/terminal/v1/merchantid/${M}`)
        return send(res, 200, [
          { id: MX_STAND_IN_TERMINAL, iid: 1, name: "Front counter Z6", providerKey: "dejavoo", enabled: true, deleted: null, uniqueIdentifier: "1" },
          { id: MX_STAND_IN_OFFLINE_TERMINAL, iid: 2, name: "Old terminal", providerKey: "dejavoo", enabled: false, deleted: null, uniqueIdentifier: "2" },
        ]);
      const create = path.match(/^\/terminal\/v1\/transaction\/merchantid\/(\d+)\/terminalid\/([^/]+)$/);
      if (create && req.method === "POST") {
        const body = await readBody(req), next = state.next;
        state.next = fresh();
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(create[2])) return send(res, 400, { message: "Validation errors" });
        if (create[2] === MX_STAND_IN_OFFLINE_TERMINAL) return send(res, 500, "Transaction was not created, because: The transaction was not sent to the terminal, because: The terminal is not connected");
        assert.ok(body.type === "Sale" || body.type === "Authorization", `Unexpected terminal transaction type ${body.type}`);
        assert.match(String(body.replayId), /^\d{15}$/, "Terminal replayId must be a 15-digit string");
        assert.equal(typeof body.amount, "number");
        if (next.mode === "gateway-no-sale") return send(res, 502, { message: "Bad gateway" });
        state.salesSent += 1;
        const id = randomUUID().toUpperCase(), amount = (next.amountOverride ?? body.amount) + next.tip;
        const paymentId = 900000 + state.salesSent;
        const payment = { id: paymentId, status: "Approved", amount: amount.toFixed(2), ...(next.tip ? { tip: next.tip.toFixed(2) } : {}), authOnly: body.type === "Authorization", paymentToken: `PT${paymentId}`, authCode: `A${paymentId}`, cardAccount: { cardType: "Visa", last4: "4242", entryMode: "Contactless" } };
        state.sales.set(id, { terminalId: create[2], amount: body.amount, replayId: body.replayId, statuses: [...next.statuses], payment });
        // MX handed the sale to the terminal and the customer tapped, but the answer to the POS was lost.
        if (next.mode === "gateway-after-accept") { post(payment, body.replayId); return send(res, 502, { message: "Bad gateway" }); }
        return send(res, 200, { message: "A transaction was sent to the terminal.", prioritypaymentsystems: { mxmerchant: { merchant: { devicePaymentAuditId: id }, transaction: {} } }, provider: { key: "dejavoo", name: "Dejavoo", transaction: { message: "A transaction was sent to the terminal." } }, status: "SENTTOTERMINAL" });
      }
      const status = path.match(/^\/terminal\/v1\/transaction\/merchantid\/(\d+)\/transactionid\/([^/]+)$/);
      if (status) {
        const sale = state.sales.get(status[2]);
        if (!sale) return send(res, 500, "The provided merchant id does not match the transaction.");
        const current = sale.statuses.length > 1 ? sale.statuses.shift()! : sale.statuses[0];
        if (current.toLowerCase() === "approved") post(sale.payment, sale.replayId);
        return send(res, 200, { status: current, message: current === "Declined" ? "DECLINED - INSUFFICIENT FUNDS" : "" });
      }
      // Completing an authorization: a sale on its card token and auth code, with the tip included in the amount.
      if (path === "/checkout/v3/payment" && req.method === "POST") {
        const body = await readBody(req), mode = state.nextCompletion;
        state.nextCompletion = "approve";
        const auth = [...state.byId.values()].find((payment) => payment.paymentToken === body.paymentToken && payment.authOnly === true);
        if (!auth || body.authOnly !== false || body.authCode !== auth.authCode || body.merchantId !== M) return send(res, 400, { message: "Invalid completion" });
        if (auth.status !== "Approved") return send(res, 200, { status: "Declined", authMessage: `Authorization is ${String(auth.status).toLowerCase()}` });
        // As in the MX sandbox: once completed, the authorization has nothing left to complete.
        const available = Number(auth.availableAuthAmount ?? auth.amount);
        if (available <= 0) return send(res, 400, { message: `The provided amount (${body.amount}) exceeds the available amount for the authorization` });
        // MX takes less than the hold (the rest stays available) or more by the tip.
        assert.ok(Math.round(Number(body.amount) * 100) <= Math.round((available + Number(body.tip || 0)) * 100), "Completion is more than the hold plus the tip");
        state.completions.push(body);
        if (mode === "decline") return send(res, 200, { status: "Declined", authMessage: "AMOUNT EXCEEDS AUTHORIZATION LIMIT" });
        const payment = { id: 800000 + state.completions.length, type: "SaleCompletion", authorizationId: auth.id, status: "Approved", amount: Number(body.amount).toFixed(2), tip: Number(body.tip || 0).toFixed(2), authOnly: false, authCode: auth.authCode, cardAccount: auth.cardAccount };
        // MX leaves the authorization "Approved" and consumes its available amount.
        auth.availableAuthAmount = (available - Number(body.amount)).toFixed(2);
        post(payment, String(body.replayId));
        if (mode === "gateway-after-capture") return send(res, 504, { message: "Gateway timeout" });
        return send(res, 201, payment);
      }
      if (path === "/checkout/v3/payment" && url.searchParams.get("merchantId") === M) {
        const payment = state.byReplay.get(String(Number(url.searchParams.get("replayId"))));
        return payment ? send(res, 200, payment) : send(res, 404);
      }
      const byId = path.match(/^\/checkout\/v3\/payment\/(\d+)$/);
      if (byId) {
        const payment = state.byId.get(byId[1]);
        if (!payment) return send(res, 404);
        if (req.method === "DELETE") {
          payment.status = "Voided";
          // Voiding a completion puts the hold back on its authorization (as the MX sandbox does).
          const auth = payment.authorizationId ? state.byId.get(String(payment.authorizationId)) : undefined;
          if (auth) auth.availableAuthAmount = (Number(auth.availableAuthAmount ?? 0) + Number(payment.amount)).toFixed(2);
          return send(res, 200, {});
        }
        return send(res, 200, payment);
      }
      send(res, 404, { message: `stand-in has no route for ${req.method} ${path}` });
    } catch (error) {
      // A failed assertion here is a bug in what the POS sent; make it loud on the caller's side too.
      console.error("MX stand-in:", error);
      send(res, 400, { message: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    state,
    /** Server environment that points the MX clients at this stand-in. */
    env: {
      MX_ENVIRONMENT: "sandbox", MX_MERCHANT_ID: M, MX_CONSUMER_KEY: "stand-in-key", MX_CONSUMER_SECRET: "stand-in-secret", MX_BUSINESS_ID: "stand-in",
      MX_TERMINAL_API_ENABLED: "true", MX_TEST_API_BASE_URL: `${base}/checkout/v3`, MX_TEST_TERMINAL_API_BASE_URL: base,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Phone card-payment recovery regression harness. Everything runs inside one
// transaction that is rolled back; MX traffic is intercepted by a fetch stub and never
// leaves the process. Outbound texts/email/push are disabled by localValidationEnv().
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "../validation-env";
localValidationEnv();
process.env.MX_ENVIRONMENT = "sandbox";
process.env.MX_MERCHANT_ID = "repro";
process.env.MX_CONSUMER_KEY = "repro";
process.env.MX_CONSUMER_SECRET = "repro";
delete process.env.MX_TEST_API_BASE_URL;

export const actor = { id: "repro-checkout", name: "Checkout repro", type: "employee" as const, role: "owner" as const };
const ROLLBACK = "rollback:repro-checkout";

export type MxStub = {
  sales: number;
  lookups: number;
  approvals: Map<number, string>;
  amounts: Map<number, number>;
  voided: Set<string>;
  /** Called for each sale POST; return a Response, throw, or await to simulate latency. */
  onSale: (body: Record<string, any>, approve: () => Response) => Promise<Response>;
};

export async function runRepro(name: string, body: (ctx: Awaited<ReturnType<typeof context>>) => Promise<Record<string, unknown>>) {
  const ctx = await context();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    assert.match(url, /sandbox\.api\.mxmerchant\.com/, "repro must never reach a non-sandbox host");
    if (url.includes("/auth/token/")) return Response.json("repro-token");
    if (init?.method === "DELETE") { ctx.mx.voided.add(url.split("/payment/")[1].split("?")[0]); return new Response(null, { status: 204 }); }
    const byId = url.match(/\/payment\/([^?/]+)/)?.[1];
    if ((init?.method || "GET") === "GET" && byId) {
      return Response.json({ id: byId, status: ctx.mx.voided.has(byId) ? "Voided" : "Approved", amount: 0, cardAccount: { cardType: "Visa", last4: "1111" } });
    }
    if ((init?.method || "GET") === "GET") {
      // Like the real MX (verified in the sandbox): a lookup by replayId returns the payment it holds.
      ctx.mx.lookups++;
      const replay = Number(new URL(url).searchParams.get("replayId"));
      const id = ctx.mx.approvals.get(replay);
      return id ? Response.json({ id, status: "Approved", amount: (ctx.mx.amounts.get(replay) ?? 0) / 100, cardAccount: { cardType: "Visa" } }) : new Response("", { status: 404 });
    }
    const payload = JSON.parse(String(init?.body));
    ctx.mx.sales++;
    const approve = () => {
      if (!ctx.mx.approvals.has(payload.replayId)) ctx.mx.approvals.set(payload.replayId, `repro-${randomUUID()}`);
      ctx.mx.amounts.set(payload.replayId, Math.round(Number(payload.amount) * 100));
      return Response.json({ status: "Approved", id: ctx.mx.approvals.get(payload.replayId), amount: Number(payload.amount), cardAccount: { cardType: "Visa" } });
    };
    return ctx.mx.onSale(payload, approve);
  }) as typeof fetch;
  let result: Record<string, unknown> = {};
  try {
    await ctx.withTransaction(async () => {
      await ctx.sql`UPDATE ordering_hardware_devices SET active=FALSE WHERE business='Corner Deli'`;
      result = await body(ctx);
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const defects = (result.defects as string[] | undefined) || [];
  console.log(JSON.stringify({ repro: name, reproduced: defects.length > 0, ...result }, null, 2));
  if (defects.length) process.exitCode = 1;
}

async function context() {
  const [{ getSql, withTransaction, inTransaction }, { priceSpokenOrder }, voice, lifecycle, alerts] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/ordering-ai-tools"),
    import("../../src/lib/ordering-voice-payment"),
    import("../../src/lib/ordering-order-lifecycle"),
    import("../../src/lib/ordering-online-alerts"),
  ]);
  // Resolve the client per query: getSql() captured outside withTransaction would bypass the rollback.
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!inTransaction()) throw new Error("repro query outside the rollback transaction");
    return getSql()(strings, ...values);
  }) as ReturnType<typeof getSql>;
  const mx: MxStub = { sales: 0, lookups: 0, approvals: new Map(), amounts: new Map(), voided: new Set(), onSale: async (_b, approve) => approve() };
  /** Removes hours rules inside the rolled-back transaction so an otherwise-valid draft can send at any clock time. */
  const openStore = async () => {
    await sql`UPDATE ordering_operating_windows SET active=FALSE WHERE business='Corner Deli'`;
    await sql`DELETE FROM ordering_special_hours WHERE business='Corner Deli'`;
    await sql`DELETE FROM ordering_emergency_closures WHERE business='Corner Deli'`;
  };
  /** A priced AI phone draft plus a voice-payment session in 'collecting', as after a successful AGI claim. */
  const make = async (service: "pickup" | "delivery" = "pickup") => {
    const order = await priceSpokenOrder({ business: "Corner Deli", actor, service, firstName: "Repro", callerPhone: "3155550100", items: [{ name: "large fries" }] });
    const callId = `repro-${randomUUID()}`;
    await sql`INSERT INTO ordering_call_sessions(id,business,three_cx_call_id,caller_phone,state,order_id) VALUES(${randomUUID()},'Corner Deli',${callId},'3155550100','handoff_pending',${order.id})`;
    const sessionId = randomUUID();
    const amount = Number((await sql`SELECT amount_due_cents FROM ordering_orders WHERE id=${order.id}`)[0].amount_due_cents);
    await sql`INSERT INTO ordering_voice_payment_sessions(id,business,call_id,order_id,caller_phone,amount_cents,replay_id,status,expires_at) VALUES(${sessionId},'Corner Deli',${callId},${order.id},'3155550100',${amount},${Math.floor(Math.random() * 2_000_000_000) + 1},'collecting',NOW()+INTERVAL '10 minutes')`;
    return { orderId: String(order.id), sessionId, callId, amount };
  };
  const charge = (sessionId: string) =>
    voice.chargeVoicePayment({ sessionId, cardNumber: "4111111111111111", expiryMonth: "12", expiryYear: "2030", cvv: "123", avsZip: "13669" });
  const state = async (fixture: { orderId: string; sessionId: string; callId: string }) => {
    const session = (await sql`SELECT status,failure_code,attempt_count,provider_transaction_reference<>'' AS has_reference FROM ordering_voice_payment_sessions WHERE id=${fixture.sessionId}`)[0];
    const order = (await sql`SELECT status,payment_status,paid_cents,amount_due_cents,total_cents FROM ordering_orders WHERE id=${fixture.orderId}`)[0];
    const call = (await sql`SELECT state,handoff_reason FROM ordering_call_sessions WHERE three_cx_call_id=${fixture.callId}`)[0];
    const payments = Number((await sql`SELECT COUNT(*)::int c FROM ordering_payment_transactions WHERE order_id=${fixture.orderId} AND transaction_type='payment'`)[0].c);
    const kitchenJobs = Number((await sql`SELECT COUNT(*)::int c FROM ordering_print_jobs WHERE order_id=${fixture.orderId} AND purpose='kitchen_production' AND parent_job_id IS NULL`)[0].c);
    const waiting = await alerts.listWaitingOnlineOrders("Corner Deli");
    const posAlert = waiting.some((row: any) => String(row.id) === fixture.orderId);
    return { session: { ...session }, order: { ...order }, call: { ...call }, payments, kitchenJobs, posAlert };
  };
  return { sql, withTransaction, mx, make, charge, state, openStore, voice, lifecycle };
}

export const errorText = async (promise: Promise<unknown>) => {
  try { await promise; return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
};

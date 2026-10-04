// Order payments taken on the payment station's MX terminal.
//
// A terminal sale spans several requests: the POS sends it, then polls while
// the customer taps, inserts, or swipes. Each sale is an
// ordering_mx_checkout_sessions row (channel 'terminal') whose
// client_mutation_id is reused for the tender, so a poll that repeats after
// the approval was recorded cannot record it twice.
//
// Dejavoo terminals cannot be cancelled through MX. When the cashier stops
// waiting, the session is only marked 'abandoned'; the next terminal sale for
// that order checks it first, so a card the customer still tapped is recorded
// instead of being charged again.
import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { ensureMxPaymentSchema, MxMerchantError, retrieveMxPayment } from "@/lib/mx-merchant";
import { getMxTerminalTransaction, newTerminalReplayId, sendMxTerminalSale } from "@/lib/mx-terminal";
import { assertOrderReadyForCheckout, checkoutState, commitTender, PaymentConflictError } from "@/lib/ordering-payments";
import { paymentStationProfile } from "@/lib/ordering-payment-stations";

let ready: Promise<void> | null = null;
function ensureSchema() {
  ready ??= (async () => {
    await ensureMxPaymentSchema();
    const sql = getSql();
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'keyed'`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS station_key TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS terminal_id TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS terminal_payment_id TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS status_message TEXT NOT NULL DEFAULT ''`;
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

/** Terminal sessions that may still turn into an approval at MX. */
const OPEN = ["sent", "abandoned"];
/** How long an abandoned sale is worth checking; the terminal gives up on the prompt well before this. */
const RECHECK_WINDOW_MINUTES = 30;

export type TerminalPaymentOutcome =
  | { state: "pending"; sessionId: string; message: string }
  | { state: "declined" | "failed"; sessionId: string; message: string }
  | { state: "approved"; sessionId: string; checkout: Awaited<ReturnType<typeof commitTender>> };

async function loadSession(business: OrderingBusiness, orderId: string, sessionId: string) {
  return (await getSql()`SELECT * FROM ordering_mx_checkout_sessions WHERE id=${sessionId} AND order_id=${orderId} AND business=${business} AND channel='terminal' LIMIT 1`)[0] || null;
}
const setStatus = (id: string, status: string, message = "") =>
  getSql()`UPDATE ordering_mx_checkout_sessions SET status=${status},status_message=${message.slice(0, 500)} WHERE id=${id}`;

/** Records an MX approval on the order. Safe to repeat: the session's mutation id makes the tender idempotent. */
async function recordApproval(session: Record<string, any>, business: OrderingBusiness, actor: OrderingActor): Promise<TerminalPaymentOutcome> {
  const replayId = Number(session.replay_id), amountCents = Number(session.amount_cents);
  const payment = await retrieveMxPayment(replayId);
  if (Math.round(Number(payment.amount) * 100) !== amountCents) {
    await setStatus(session.id, "needs_review", `MX approved ${payment.amount} but the POS sent ${(amountCents / 100).toFixed(2)}.`);
    throw new MxMerchantError("The terminal approval amount does not match this sale. A manager must check it in MX Merchant before taking another payment.");
  }
  const reference = String(payment.id || payment.reference || "");
  if (!reference) throw new MxMerchantError("MX did not return a transaction reference for the terminal sale.");
  const card = payment.cardAccount && typeof payment.cardAccount === "object" ? payment.cardAccount as Record<string, unknown> : {};
  try {
    const checkout = await commitTender({
      orderId: String(session.order_id), business, tenderType: "card", amountTenderedCents: amountCents,
      clientMutationId: String(session.client_mutation_id), checkId: session.check_id || null, actor, stationKey: String(session.station_key || ""),
      providerApproval: {
        provider: "mx_merchant", transactionReference: reference,
        brand: String(card.cardType || ""), last4: String(card.last4 || "").replace(/\D/g, "").slice(-4),
        details: { replayId, channel: "pos_terminal", terminalId: session.terminal_id, terminalPaymentId: session.terminal_payment_id, entryMode: payment.entryMode ?? null, authCode: payment.authCode ?? null },
      },
    });
    await getSql()`UPDATE ordering_mx_checkout_sessions SET status='completed',status_message='',provider_transaction_reference=${reference},completed_at=NOW() WHERE id=${session.id}`;
    return { state: "approved", sessionId: String(session.id), checkout };
  } catch (error) {
    // The card was charged but the order would not take it (paid another way meanwhile, or changed). Never drop that silently.
    if (error instanceof PaymentConflictError) {
      await setStatus(session.id, "needs_review", `MX approved ${reference} but the POS could not record it: ${error.message}`);
      throw new PaymentConflictError(`The terminal charged the card $${(amountCents / 100).toFixed(2)}, but the POS could not add it to this order (${error.message}) A manager must refund MX payment ${reference} or record it.`);
    }
    throw error;
  }
}

/** Polls MX for one terminal sale and records it when approved. */
export async function checkTerminalPayment(input: { business: OrderingBusiness; orderId: string; sessionId: string; actor: OrderingActor }): Promise<TerminalPaymentOutcome> {
  await ensureSchema();
  const session = await loadSession(input.business, input.orderId, input.sessionId);
  if (!session) throw new MxMerchantError("This terminal payment was not found.");
  const sessionId = String(session.id);
  if (session.status === "completed")
    return { state: "approved", sessionId, checkout: { ...(await checkoutState(input.orderId, input.business, session.check_id)), duplicate: true } as Awaited<ReturnType<typeof commitTender>> };
  if (session.status === "declined" || session.status === "failed" || session.status === "send_failed") return { state: session.status === "declined" ? "declined" : "failed", sessionId, message: String(session.status_message || "The terminal did not take the card.") };
  if (session.status === "needs_review") throw new MxMerchantError(String(session.status_message || "This terminal sale needs a manager to check it in MX Merchant."));
  if (!OPEN.includes(String(session.status)) || !session.terminal_payment_id) return { state: "pending", sessionId, message: "Sending the sale to the terminal…" };
  const mx = await getMxTerminalTransaction(String(session.terminal_payment_id));
  if (mx.state === "approved") return recordApproval(session, input.business, input.actor);
  if (mx.state === "declined" || mx.state === "failed") {
    const message = mx.message || (mx.state === "declined" ? "The card was declined." : "The terminal did not complete the sale.");
    await setStatus(sessionId, mx.state, message);
    return { state: mx.state, sessionId, message };
  }
  return { state: "pending", sessionId, message: mx.message || "Waiting for the customer to tap, insert, or swipe." };
}

/**
 * Sends a sale for the order (or one check) to the station's MX terminal.
 * Earlier unfinished sales for the order are checked first; if one of them
 * was approved after all, it is recorded and returned instead of charging again.
 */
export async function startTerminalPayment(input: { business: OrderingBusiness; orderId: string; checkId?: string | null; amountCents?: number | null; stationKey: string; actor: OrderingActor }): Promise<TerminalPaymentOutcome> {
  await ensureSchema();
  await assertOrderReadyForCheckout(input.orderId, input.business);
  const station = await paymentStationProfile(input.business, input.stationKey);
  if (!station || station.station_mode !== "payment") throw new PaymentConflictError("Card terminal sales must be started from the payment station.");
  if (!station.mx_terminal_ready) throw new PaymentConflictError("This payment station has no MX card terminal ready. Check POS settings → Hardware.");
  const sql = getSql();

  const earlier = await sql`SELECT id,status,created_at FROM ordering_mx_checkout_sessions WHERE order_id=${input.orderId} AND business=${input.business} AND channel='terminal' AND status IN ('sending','sent','abandoned') AND created_at>NOW()-make_interval(mins=>${RECHECK_WINDOW_MINUTES}) ORDER BY created_at`;
  for (const row of earlier) {
    if (row.status === "sending") {
      if (Date.now() - new Date(row.created_at).getTime() < 60_000) throw new PaymentConflictError("A card sale is already being sent to the terminal. Wait a moment.");
      continue;
    }
    const outcome = await checkTerminalPayment({ ...input, sessionId: String(row.id) });
    if (outcome.state === "approved") return outcome;
    if (outcome.state === "pending" && row.status === "sent") throw new PaymentConflictError("The terminal is still waiting for a card on this order. Finish or stop that sale first.");
  }

  const state = await checkoutState(input.orderId, input.business, input.checkId || null);
  const remaining = Number(state.check?.amount_due_cents ?? state.order.amount_due_cents);
  const amount = input.amountCents == null ? remaining : Math.trunc(Number(input.amountCents));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) throw new PaymentConflictError("Enter a card amount within the remaining balance.");

  const sessionId = randomUUID(), replayId = newTerminalReplayId(), terminalId = String(station.terminal_mx_id).toUpperCase();
  // Saved before MX is called, so a sale that reaches the terminal is never untracked.
  await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,check_id,amount_cents,replay_id,client_mutation_id,status,channel,station_key,terminal_id,created_by,expires_at)
    VALUES(${sessionId},${input.business},${input.orderId},${input.checkId || null},${amount},${replayId},${randomUUID()},'sending','terminal',${String(station.station_key)},${terminalId},${input.actor.id},NOW()+make_interval(mins=>${RECHECK_WINDOW_MINUTES}))`;
  try {
    const sent = await sendMxTerminalSale({ terminalId, amountCents: amount, replayId });
    await sql`UPDATE ordering_mx_checkout_sessions SET status='sent',terminal_payment_id=${sent.terminalPaymentId} WHERE id=${sessionId}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The sale could not be sent to the terminal.";
    await setStatus(sessionId, "send_failed", message);
    throw error instanceof MxMerchantError ? error : new MxMerchantError(message);
  }
  return { state: "pending", sessionId, message: `Sent $${(amount / 100).toFixed(2)} to the terminal. Ask the customer to tap, insert, or swipe.` };
}

/** The cashier stopped waiting. The sale stays on record so a late approval is still found. */
export async function abandonTerminalPayment(input: { business: OrderingBusiness; orderId: string; sessionId: string }) {
  await ensureSchema();
  await getSql()`UPDATE ordering_mx_checkout_sessions SET status='abandoned' WHERE id=${input.sessionId} AND order_id=${input.orderId} AND business=${input.business} AND channel='terminal' AND status='sent'`;
}

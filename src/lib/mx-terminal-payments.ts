// Order payments taken on the payment station's MX terminal.
//
// The customer pays first and tips after, on one charge: the POS sends an
// *authorization* for the balance as checkout opens, the customer taps,
// inserts, or swipes, and once MX approves it the POS asks for a tip and
// completes the authorization for balance + tip
// (https://developer.mxmerchant.com/docs/making-an-adjustment). The order is
// only marked paid once that completion is approved.
//
// Each sale is an ordering_mx_checkout_sessions row (channel 'terminal'). Its
// client_mutation_id is reused for the tender, so a poll that repeats after
// the payment was recorded cannot record it twice.
//
// A sale the POS has lost track of can still charge the card, so these are
// never treated as failed on the POS's word alone:
// - Dejavoo terminals cannot be cancelled through MX. When the cashier stops
//   waiting, the sale is only marked 'abandoned'.
// - If MX's answer to the send never arrives, the sale may be on the terminal
//   anyway ('send_unknown'). It has no terminal payment id, so it is looked up
//   by the replayId the POS chose before sending.
// - An approved authorization that nobody tips on is completed without a tip,
//   by the next payment attempt on the order or by the maintenance sweep, so
//   the hold always becomes a charge on the order.
// Every way of paying an order (terminal, cash, gift card, keyed card) first
// calls settleOpenTerminalSales, which records any such sale and refuses to
// take a second payment while the terminal may still be charging the card.
//
// Status lifecycle: sending → sent | send_unknown | send_failed;
// sent | send_unknown | abandoned → authorized | declined | failed | needs_review;
// authorized → completing → completed (or back to authorized if MX declines the tip);
// authorized → voiding → voided (or back to authorized);
// needs_review → resolved (by a manager).
import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import { completeMxAuthorization, ensureMxPaymentSchema, findMxPaymentByReplayId, getMxPayment, MxMerchantError, MxMerchantUnreachableError, newReplayId, voidOrRefundMxPayment } from "@/lib/mx-merchant";
import { getMxTerminalTransaction, newTerminalReplayId, sendMxTerminalSale, type MxTerminalState } from "@/lib/mx-terminal";
import { assertOrderReadyForCheckout, checkoutState, commitTender, PaymentConflictError, setCheckoutTip } from "@/lib/ordering-payments";
import { paymentStationProfile } from "@/lib/ordering-payment-stations";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { submitPaidDraft } from "@/lib/ordering-paid-draft-submit";

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
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS auth_reference TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS payment_token TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS auth_code TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS tip_cents INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS completion_replay_id BIGINT`;
    await sql`ALTER TABLE ordering_mx_checkout_sessions ADD COLUMN IF NOT EXISTS completion_started_at TIMESTAMPTZ`;
    // One sale in flight per terminal, even if two requests race past the busy check.
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_mx_terminal_one_active_idx ON ordering_mx_checkout_sessions(terminal_id) WHERE channel='terminal' AND status IN ('sending','sent')`;
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

/** Sales that may still turn into an approval at MX. */
const OPEN = ["sending", "sent", "send_unknown", "abandoned"];
/** Approved and held on the card: waiting for the tip, being completed, or being released. */
const HELD = ["authorized", "completing", "voiding"];
/** A completion or release this recent is still in flight in another request; don't send it again. */
const IN_FLIGHT_SECONDS = 60;
const inFlight = (since: unknown) => ageMinutes(since) * 60 < IN_FLIGHT_SECONDS;
/** While MX still calls a sale pending, the terminal may be prompting for this long; nothing else is charged meanwhile. */
const PROMPT_MINUTES = 3;
/** Past this, a sale MX has no payment for is treated as never charged. The terminal gave up long before. */
const GIVE_UP_MINUTES = 10;
/** How far back open sales are checked before another payment. */
const RECHECK_WINDOW_MINUTES = 30;
/** An approved authorization left this long without a tip is completed without one. */
const TIP_WAIT_MINUTES = 10;
/** Who completes authorizations nobody tipped on. */
const AUTO_CAPTURE_ACTOR: OrderingActor = { id: "system:mx-terminal", name: "Card terminal auto-capture", type: "employee", role: "employee" };

type Checkout = Awaited<ReturnType<typeof commitTender>>;
export type TerminalPaymentOutcome =
  | { state: "pending"; sessionId: string; message: string }
  | { state: "authorized"; sessionId: string; amountCents: number; message: string }
  | { state: "declined" | "failed" | "needs_review"; sessionId: string; message: string }
  | { state: "approved"; sessionId: string; checkout: Checkout; amountCents?: number; kitchenWarning?: string };

type Session = Record<string, any>;
const ageMinutes = (since: unknown) => (Date.now() - new Date(String(since)).getTime()) / 60_000;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const toCents = (value: unknown) => Math.round(Number(value || 0) * 100);
const setStatus = (id: string, status: string, message = "") =>
  getSql()`UPDATE ordering_mx_checkout_sessions SET status=${status},status_message=${message.slice(0, 500)} WHERE id=${id}`;
const uniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "23505";
const markNeedsReview = (id: string, reference: string, message: string) =>
  getSql()`UPDATE ordering_mx_checkout_sessions SET status='needs_review',provider_transaction_reference=${reference},status_message=${message.slice(0, 500)} WHERE id=${id}`;
const authorizedOutcome = (session: Session, message = ""): TerminalPaymentOutcome =>
  ({ state: "authorized", sessionId: String(session.id), amountCents: Number(session.amount_cents), message: message || "Card approved. Ask the customer about a tip." });

async function loadSession(business: OrderingBusiness, orderId: string, sessionId: string): Promise<Session | null> {
  return (await getSql()`SELECT * FROM ordering_mx_checkout_sessions WHERE id=${sessionId} AND order_id=${orderId} AND business=${business} AND channel='terminal' LIMIT 1`)[0] || null;
}

function paymentState(payment: Record<string, unknown>): MxTerminalState {
  const status = String(payment.status || "").toLowerCase();
  if (status.includes("void") || status.includes("refund") || status.includes("return")) return "failed";
  if (status.includes("approve") || status.includes("settled")) return "approved";
  if (status.includes("decline")) return "declined";
  return "pending";
}

/** Asks MX where one sale stands, using the terminal transaction when MX gave us one, otherwise the payment record. */
async function probe(session: Session): Promise<{ state: MxTerminalState; message: string; payment?: Record<string, unknown> }> {
  const age = ageMinutes(session.created_at);
  if (session.terminal_payment_id) {
    const mx = await getMxTerminalTransaction(String(session.terminal_payment_id));
    if (mx.state === "declined" || mx.state === "failed" || mx.state === "approved") return mx;
    // MX can leave a sale "pending" after the terminal gave up; past the prompt window the payment record decides.
    if (age < PROMPT_MINUTES) return mx;
  }
  const payment = await findMxPaymentByReplayId(Number(session.replay_id));
  if (payment) {
    const state = paymentState(payment);
    if (state === "failed") return { state, message: `MX shows this sale as ${String(payment.status).toLowerCase()}.` };
    if (state !== "pending") return { state, message: String(payment.authMessage || ""), payment };
  }
  if (age < GIVE_UP_MINUTES) return { state: "pending", message: session.terminal_payment_id ? "Waiting for the customer to tap, insert, or swipe." : "Checking with MX whether the sale reached the terminal…" };
  return { state: "failed", message: "MX has no payment for this sale, so the card was not charged." };
}

/** The terminal approved the authorization: keep what completing it needs, then ask for the tip. */
async function recordAuthorization(session: Session, known?: Record<string, unknown>): Promise<TerminalPaymentOutcome> {
  const sessionId = String(session.id), sentCents = Number(session.amount_cents);
  const payment = known ?? await findMxPaymentByReplayId(Number(session.replay_id));
  if (!payment || paymentState(payment) !== "approved") return { state: "pending", sessionId, message: "The terminal approved the card. Waiting for MX to post it…" };
  const reference = String(payment.id || payment.reference || "");
  if (!reference) return { state: "pending", sessionId, message: "Waiting for MX to post the payment reference…" };
  const approvedCents = toCents(payment.amount), token = String(payment.paymentToken || ""), authCode = String(payment.authCode || "");
  if (approvedCents !== sentCents || !token) {
    const message = approvedCents !== sentCents
      ? `The terminal approved ${dollars(approvedCents)} but the POS sent ${dollars(sentCents)}, so it was not added to the order. A manager must check MX payment ${reference} and void or record it.`
      : `MX approved the card but returned no card token, so the POS cannot finish the charge. A manager must complete or void MX payment ${reference} in MX Merchant.`;
    await markNeedsReview(sessionId, reference, message);
    return { state: "needs_review", sessionId, message };
  }
  await getSql()`UPDATE ordering_mx_checkout_sessions SET status='authorized',status_message='',auth_reference=${reference},payment_token=${token},auth_code=${authCode},authorized_at=COALESCE(authorized_at,NOW()) WHERE id=${sessionId} AND status IN ('sending','sent','send_unknown','abandoned')`;
  return authorizedOutcome({ ...session, status: "authorized" });
}

/** Records the completed charge (balance + tip) on the order. Safe to repeat: the session's mutation id makes the tender idempotent. */
async function recordCompletion(session: Session, business: OrderingBusiness, actor: OrderingActor, payment: Record<string, unknown>): Promise<TerminalPaymentOutcome> {
  const sessionId = String(session.id), orderId = String(session.order_id), checkId = session.check_id ? String(session.check_id) : null;
  const tipCents = Number(session.tip_cents || 0), expectedCents = Number(session.amount_cents) + tipCents;
  const reference = String(payment.id || payment.reference || ""), approvedCents = toCents(payment.amount);
  if (approvedCents !== expectedCents || !reference) {
    const message = `MX completed the card for ${dollars(approvedCents)} but the POS expected ${dollars(expectedCents)}, so it was not added to the order. A manager must check MX payment ${reference || session.auth_reference}.`;
    await markNeedsReview(sessionId, reference || String(session.auth_reference), message);
    return { state: "needs_review", sessionId, message };
  }
  const card = payment.cardAccount && typeof payment.cardAccount === "object" ? payment.cardAccount as Record<string, unknown> : {};
  try {
    const checkout = await withTransaction(async () => {
      const sql = getSql();
      const alreadyRecorded = (await sql`SELECT 1 FROM ordering_payment_transactions WHERE business=${business} AND client_mutation_id=${String(session.client_mutation_id)} LIMIT 1`).length > 0;
      if (tipCents > 0 && !alreadyRecorded) {
        const current = checkId
          ? (await sql`SELECT tip_cents FROM ordering_checks WHERE id=${checkId} AND order_id=${orderId}`)[0]
          : (await sql`SELECT tip_cents FROM ordering_orders WHERE id=${orderId} AND business=${business}`)[0];
        await setCheckoutTip({ orderId, business, checkId, tipCents: Number(current?.tip_cents || 0) + tipCents, actor });
      }
      return commitTender({
        orderId, business, tenderType: "card", amountTenderedCents: approvedCents,
        clientMutationId: String(session.client_mutation_id), checkId, actor, stationKey: String(session.station_key || ""),
        providerApproval: {
          provider: "mx_merchant", transactionReference: reference,
          brand: String(card.cardType || ""), last4: String(card.last4 || "").replace(/\D/g, "").slice(-4),
          details: { replayId: Number(session.replay_id), completionReplayId: Number(session.completion_replay_id), channel: "pos_terminal", terminalId: session.terminal_id, terminalPaymentId: session.terminal_payment_id, authorizationReference: session.auth_reference, entryMode: card.entryMode ?? null, authCode: session.auth_code || null, tipCents },
        },
      });
    });
    await getSql()`UPDATE ordering_mx_checkout_sessions SET status='completed',status_message='',provider_transaction_reference=${reference},completed_at=NOW() WHERE id=${sessionId}`;
    return { state: "approved", sessionId, checkout, amountCents: approvedCents };
  } catch (error) {
    // Another request recorded this payment at the same moment (unique mutation id).
    if (uniqueViolation(error)) {
      await getSql()`UPDATE ordering_mx_checkout_sessions SET status='completed',provider_transaction_reference=${reference},completed_at=COALESCE(completed_at,NOW()) WHERE id=${sessionId} AND status<>'completed'`;
      return { state: "approved", sessionId, checkout: { ...(await checkoutState(orderId, business, checkId)), duplicate: true } as Checkout, amountCents: approvedCents };
    }
    // The card was charged but the order would not take it (paid another way meanwhile, or changed). Never drop that silently.
    if (error instanceof PaymentConflictError) {
      const message = `The terminal charged the card ${dollars(approvedCents)}, but the POS could not add it to this order (${error.message.replace(/\.$/, "")}). A manager must refund MX payment ${reference} or record it.`;
      await markNeedsReview(sessionId, reference, message);
      return { state: "needs_review", sessionId, message };
    }
    throw error;
  }
}

/**
 * Sends (or resumes) the completion of an authorization. If MX's answer was lost, the completion is looked up by its
 * replayId before trying again, so the card is never charged twice. A decline (usually the tip) returns to the tip step.
 */
async function finishCompletion(session: Session, business: OrderingBusiness, actor: OrderingActor): Promise<TerminalPaymentOutcome> {
  const sessionId = String(session.id), tipCents = Number(session.tip_cents || 0), totalCents = Number(session.amount_cents) + tipCents;
  if (!session.completion_replay_id) throw new MxMerchantError("This card payment has no completion on record.");
  await getSql()`UPDATE ordering_mx_checkout_sessions SET completion_started_at=NOW() WHERE id=${sessionId}`;
  const already = await findMxPaymentByReplayId(Number(session.completion_replay_id));
  if (already && paymentState(already) === "approved") return recordCompletion(session, business, actor, already);
  try {
    const payment = await completeMxAuthorization({ paymentToken: String(session.payment_token), authCode: String(session.auth_code), amountCents: totalCents, tipCents, replayId: Number(session.completion_replay_id) });
    return recordCompletion(session, business, actor, payment);
  } catch (error) {
    if (error instanceof MxMerchantUnreachableError) return { state: "pending", sessionId, message: `${error.message} Finishing the card payment…` };
    if (error instanceof MxMerchantError) {
      // MX refuses a second completion of the same authorization. If its hold is already used up, this sale was
      // charged by an earlier attempt: find that charge rather than asking for a tip again.
      const auth = await getMxPayment(String(session.auth_reference)).catch(() => null);
      if (auth && Number(auth.availableAuthAmount ?? 1) <= 0) {
        const charged = await findMxPaymentByReplayId(Number(session.completion_replay_id));
        if (charged && paymentState(charged) === "approved") return recordCompletion(session, business, actor, charged);
        const message = `MX already charged this card (authorization ${session.auth_reference} is used up), but the POS cannot find the charge to add it to the order. A manager must check MX Merchant.`;
        await markNeedsReview(sessionId, String(session.auth_reference), message);
        return { state: "needs_review", sessionId, message };
      }
      const message = tipCents ? `MX did not accept ${dollars(totalCents)} with the tip (${error.message.replace(/\.$/, "")}). Choose a different tip or no tip.` : `MX did not accept the final charge (${error.message.replace(/\.$/, "")}).`;
      await getSql()`UPDATE ordering_mx_checkout_sessions SET status='authorized',tip_cents=0,completion_replay_id=NULL,status_message=${message.slice(0, 500)} WHERE id=${sessionId} AND status='completing'`;
      return authorizedOutcome(session, message);
    }
    throw error;
  }
}

/** Claims an authorization for completion with this tip; only one request wins, the rest resume it. */
async function completeWithTip(session: Session, business: OrderingBusiness, actor: OrderingActor, tipCents: number): Promise<TerminalPaymentOutcome> {
  if (session.status === "authorized") {
    const claimed = (await getSql()`UPDATE ordering_mx_checkout_sessions SET status='completing',tip_cents=${tipCents},completion_replay_id=${newReplayId()},completion_started_at=NOW(),status_message='' WHERE id=${session.id} AND status='authorized' RETURNING *`)[0];
    if (claimed) return finishCompletion(claimed, business, actor);
    session = (await getSql()`SELECT * FROM ordering_mx_checkout_sessions WHERE id=${session.id}`)[0];
  }
  return advance(session, business, actor);
}

/** Brings one sale up to date with MX: records an authorization, resumes a completion, or reports where it stands. */
async function advance(session: Session, business: OrderingBusiness, actor: OrderingActor): Promise<TerminalPaymentOutcome> {
  const sessionId = String(session.id), status = String(session.status);
  if (status === "completed")
    return { state: "approved", sessionId, checkout: { ...(await checkoutState(String(session.order_id), business, session.check_id)), duplicate: true } as Checkout };
  if (status === "authorized") return authorizedOutcome(session, String(session.status_message || ""));
  if (status === "completing")
    return inFlight(session.completion_started_at) ? { state: "pending", sessionId, message: "Finishing the card payment…" } : finishCompletion(session, business, actor);
  if (status === "voiding") return inFlight(session.completion_started_at) ? { state: "pending", sessionId, message: "Releasing the card…" } : recheckVoid(session);
  if (status === "needs_review" || status === "resolved") return { state: "needs_review", sessionId, message: String(session.status_message || "This terminal sale needs a manager to check it in MX Merchant.") };
  if (status === "voided") return { state: "failed", sessionId, message: String(session.status_message || "The card was released.") };
  if (!OPEN.includes(status)) return { state: status === "declined" ? "declined" : "failed", sessionId, message: String(session.status_message || "The terminal did not take the card.") };
  if (status === "sending") {
    if (ageMinutes(session.created_at) < 1) return { state: "pending", sessionId, message: "Sending the sale to the terminal…" };
    // The request that was sending it died; the sale may be on the terminal.
    await getSql()`UPDATE ordering_mx_checkout_sessions SET status='send_unknown' WHERE id=${sessionId} AND status='sending'`;
    session = { ...session, status: "send_unknown" };
  }
  const mx = await probe(session);
  if (mx.state === "approved") return recordAuthorization(session, mx.payment);
  if (mx.state === "declined" || mx.state === "failed") {
    const message = mx.message || (mx.state === "declined" ? "The card was declined." : "The terminal did not complete the sale.");
    await setStatus(sessionId, mx.state, message);
    return { state: mx.state, sessionId, message };
  }
  return { state: "pending", sessionId, message: mx.message || "Waiting for the customer to tap, insert, or swipe." };
}

/** Polls MX for one terminal sale. */
export async function checkTerminalPayment(input: { business: OrderingBusiness; orderId: string; sessionId: string; actor: OrderingActor }): Promise<TerminalPaymentOutcome> {
  await ensureSchema();
  const session = await loadSession(input.business, input.orderId, input.sessionId);
  if (!session) return { state: "failed", sessionId: input.sessionId, message: "This terminal payment was not found. Check the order's payments before charging again." };
  return advance(session, input.business, input.actor);
}

/** The customer chose a tip (0 for none): charge the approved card for balance + tip and record it on the order. */
export async function completeTerminalPayment(input: { business: OrderingBusiness; orderId: string; sessionId: string; tipCents: number; actor: OrderingActor }): Promise<TerminalPaymentOutcome> {
  await ensureSchema();
  if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0) throw new PaymentConflictError("Enter a tip of $0.00 or more.");
  const session = await loadSession(input.business, input.orderId, input.sessionId);
  if (!session) throw new PaymentConflictError("This terminal payment was not found.");
  if (!HELD.includes(String(session.status)) && session.status !== "completed") throw new PaymentConflictError("This card has not been approved yet.");
  return completeWithTip(session, input.business, input.actor, input.tipCents);
}

/** The customer changed their mind after the card was approved: release the hold instead of charging it. */
export async function voidTerminalAuthorization(input: { business: OrderingBusiness; orderId: string; sessionId: string }) {
  await ensureSchema();
  const claimed = (await getSql()`UPDATE ordering_mx_checkout_sessions SET status='voiding',completion_started_at=NOW(),status_message='' WHERE id=${input.sessionId} AND order_id=${input.orderId} AND business=${input.business} AND channel='terminal' AND status='authorized' RETURNING *`)[0];
  if (!claimed) throw new PaymentConflictError("Only an approved card that has not been charged yet can be released.");
  try {
    await voidOrRefundMxPayment(String(claimed.auth_reference));
  } catch (error) {
    if (error instanceof MxMerchantUnreachableError) throw new MxMerchantError(`${error.message} The POS will check whether the card was released.`);
    await setStatus(String(claimed.id), "authorized", "");
    throw error instanceof MxMerchantError ? error : new MxMerchantError("MX could not release the card.");
  }
  await setStatus(String(claimed.id), "voided", "The card was released without charging it.");
}

/** A release whose answer was lost: MX's record of the authorization says whether it went through. */
async function recheckVoid(session: Session): Promise<TerminalPaymentOutcome> {
  const payment = await findMxPaymentByReplayId(Number(session.replay_id));
  if (payment && paymentState(payment) === "approved") {
    await setStatus(String(session.id), "authorized", "");
    return authorizedOutcome(session);
  }
  await setStatus(String(session.id), "voided", "The card was released without charging it.");
  return { state: "failed", sessionId: String(session.id), message: "The card was released without charging it." };
}

/**
 * Kitchen send and receipts after a terminal payment is recorded, the same as after a keyed MX approval.
 * Returns a warning when the paid order could not be sent to the kitchen.
 */
export async function finishTerminalApproval(outcome: TerminalPaymentOutcome & { state: "approved" }, orderId: string, business: OrderingBusiness, actor: OrderingActor) {
  if (outcome.checkout.duplicate) return outcome;
  if (outcome.checkout.order.payment_status === "paid" && outcome.checkout.order.status === "draft") {
    const unsent = await submitPaidDraft(orderId, business, actor);
    if (unsent) return { ...outcome, kitchenWarning: String(((await unsent.json()) as { error?: string }).error || "The order was paid but not sent to the kitchen.") };
    await dispatchSubmittedOrderPrintJobs(orderId, business);
  } else {
    await dispatchOrderPrintJobs(orderId, business, { includeKitchenProduction: false });
  }
  return outcome;
}

/** Another payment was refused because a terminal sale on the order just went through; carries the new balance for the POS. */
export class TerminalSaleRecordedError extends PaymentConflictError {
  constructor(message: string, readonly checkout: Checkout) { super(message); }
}

type Settled = { recorded: (TerminalPaymentOutcome & { state: "approved" })[]; authorized: TerminalPaymentOutcome[]; blocker: string };
/**
 * Brings every terminal sale on the order up to date. With `captureHeld`, approved cards still waiting for a tip
 * are completed without one (another payment is being attempted, so the tip step was left behind).
 */
async function settleOrder(input: { business: OrderingBusiness; orderId: string; actor: OrderingActor }, captureHeld: boolean): Promise<Settled> {
  await ensureSchema();
  const rows = await getSql()`SELECT * FROM ordering_mx_checkout_sessions WHERE business=${input.business} AND order_id=${input.orderId} AND channel='terminal'
    AND (status IN ('needs_review','authorized','completing','voiding') OR (status IN ('sending','sent','send_unknown','abandoned') AND created_at>NOW()-make_interval(mins=>${RECHECK_WINDOW_MINUTES}))) ORDER BY created_at`;
  const settled: Settled = { recorded: [], authorized: [], blocker: "" };
  for (const row of rows) {
    let outcome = await advance(row, input.business, input.actor);
    if (outcome.state === "authorized" && captureHeld) outcome = await completeWithTip({ ...row, status: "authorized" }, input.business, input.actor, 0);
    if (outcome.state === "approved") settled.recorded.push(await finishTerminalApproval(outcome, input.orderId, input.business, input.actor));
    else if (outcome.state === "authorized") settled.authorized.push(outcome);
    else if (outcome.state === "needs_review") settled.blocker ||= `${outcome.message} Mark it resolved in POS settings → Hardware before taking another payment on this order.`;
    else if (outcome.state === "pending" && (HELD.includes(String(row.status)) || ageMinutes(row.created_at) < PROMPT_MINUTES))
      settled.blocker ||= "The terminal may still charge the card for this order. Have the customer finish, or cancel it on the terminal (red X), and try again in a moment.";
  }
  return settled;
}

/**
 * Settles every terminal sale on this order that might still charge the card.
 * Throws instead of letting another payment through when one was just recorded
 * (the balance changed), needs a manager, or may still be on the terminal.
 * Call before taking any other payment on the order.
 */
export async function settleOpenTerminalSales(input: { business: OrderingBusiness; orderId: string; actor: OrderingActor }) {
  const { recorded, blocker } = await settleOrder(input, true);
  if (recorded.length) {
    const total = recorded.reduce((sum, outcome) => sum + Number(outcome.amountCents || 0), 0);
    throw new TerminalSaleRecordedError(`An earlier card sale on the terminal${total ? ` for ${dollars(total)}` : ""} went through and was added to this order. Check the balance before taking another payment.`, recorded[recorded.length - 1].checkout);
  }
  if (blocker) throw new PaymentConflictError(blocker);
}

/**
 * Sends an authorization for the order (or one check) to the station's MX terminal.
 * Earlier sales on this order and anything still on this terminal are settled first;
 * an approved card still waiting for its tip is handed back instead of charging again.
 */
export async function startTerminalPayment(input: { business: OrderingBusiness; orderId: string; checkId?: string | null; amountCents?: number | null; stationKey: string; actor: OrderingActor }): Promise<TerminalPaymentOutcome> {
  await ensureSchema();
  await assertOrderReadyForCheckout(input.orderId, input.business);
  const station = await paymentStationProfile(input.business, input.stationKey);
  if (!station || station.station_mode !== "payment") throw new PaymentConflictError("Card terminal sales must be started from the payment station.");
  if (!station.mx_terminal_ready) throw new PaymentConflictError("This payment station has no MX card terminal ready. Check POS settings → Hardware.");
  const sql = getSql(), terminalId = String(station.terminal_mx_id).toUpperCase();

  const settled = await settleOrder(input, false);
  if (settled.authorized.length) return settled.authorized[0];
  if (settled.recorded.length) return settled.recorded[settled.recorded.length - 1];
  if (settled.blocker) throw new PaymentConflictError(settled.blocker);
  // Other orders' sales still on this terminal.
  const others = await sql`SELECT session.*,orders.display_number FROM ordering_mx_checkout_sessions session JOIN ordering_orders orders ON orders.id=session.order_id
    WHERE session.business=${input.business} AND session.channel='terminal' AND session.terminal_id=${terminalId} AND session.order_id<>${input.orderId}
      AND session.status IN ('sending','sent','send_unknown','abandoned') AND session.created_at>NOW()-make_interval(mins=>${RECHECK_WINDOW_MINUTES}) ORDER BY session.created_at`;
  for (const row of others) {
    const outcome = await advance(row, input.business, input.actor);
    if (outcome.state === "pending" && ageMinutes(row.created_at) < PROMPT_MINUTES)
      throw new PaymentConflictError(`The terminal is still showing the card sale for order #${row.display_number}. Finish or cancel it on the terminal first.`);
  }
  // Sales MX still calls pending past the prompt window no longer hold the terminal; they stay on record for late approvals.
  await sql`UPDATE ordering_mx_checkout_sessions SET status='abandoned' WHERE channel='terminal' AND terminal_id=${terminalId} AND status='sent' AND created_at<=NOW()-make_interval(mins=>${PROMPT_MINUTES})`;

  const state = await checkoutState(input.orderId, input.business, input.checkId || null);
  const remaining = Number(state.check?.amount_due_cents ?? state.order.amount_due_cents);
  const amount = input.amountCents == null ? remaining : Math.trunc(Number(input.amountCents));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) throw new PaymentConflictError("Enter a card amount within the remaining balance.");

  const sessionId = randomUUID(), replayId = newTerminalReplayId();
  // Saved before MX is called, so a sale that reaches the terminal is never untracked.
  try {
    await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,check_id,amount_cents,replay_id,client_mutation_id,status,channel,station_key,terminal_id,created_by,expires_at)
      VALUES(${sessionId},${input.business},${input.orderId},${input.checkId || null},${amount},${replayId},${randomUUID()},'sending','terminal',${String(station.station_key)},${terminalId},${input.actor.id},NOW()+make_interval(mins=>${RECHECK_WINDOW_MINUTES}))`;
  } catch (error) {
    if (uniqueViolation(error)) throw new PaymentConflictError("Another card sale was just sent to this terminal. Wait for it to finish.");
    throw error;
  }
  try {
    const sent = await sendMxTerminalSale({ terminalId, amountCents: amount, replayId, type: "Authorization" });
    await sql`UPDATE ordering_mx_checkout_sessions SET status='sent',terminal_payment_id=${sent.terminalPaymentId} WHERE id=${sessionId} AND status='sending'`;
  } catch (error) {
    if (error instanceof MxMerchantUnreachableError) {
      // MX may have passed the sale to the terminal; keep checking by replayId instead of calling it failed.
      await setStatus(sessionId, "send_unknown", error.message);
      return { state: "pending", sessionId, message: `${error.message} If the terminal shows ${dollars(amount)}, let the customer pay; the POS is checking with MX.` };
    }
    const message = error instanceof Error ? error.message : "The sale could not be sent to the terminal.";
    await setStatus(sessionId, "send_failed", message);
    throw error instanceof MxMerchantError ? error : new MxMerchantError(message);
  }
  return { state: "pending", sessionId, message: `${dollars(amount)} is on the terminal. The customer can tap, insert, or swipe now.` };
}

/** The cashier stopped waiting. The sale stays on record so a late approval is still found. */
export async function abandonTerminalPayment(input: { business: OrderingBusiness; orderId: string; sessionId: string }) {
  await ensureSchema();
  await getSql()`UPDATE ordering_mx_checkout_sessions SET status='abandoned' WHERE id=${input.sessionId} AND order_id=${input.orderId} AND business=${input.business} AND channel='terminal' AND status IN ('sent','send_unknown')`;
}

/**
 * Maintenance sweep: completes approved cards left waiting for a tip (no tip) and resumes interrupted completions,
 * so a hold never lapses without being charged to its order.
 */
export async function captureStaleTerminalAuthorizations(business: OrderingBusiness) {
  await ensureSchema();
  const rows = await getSql()`SELECT * FROM ordering_mx_checkout_sessions WHERE business=${business} AND channel='terminal'
    AND ((status='authorized' AND authorized_at<=NOW()-make_interval(mins=>${TIP_WAIT_MINUTES})) OR (status IN ('completing','voiding') AND completion_started_at<=NOW()-make_interval(secs=>${IN_FLIGHT_SECONDS}))) ORDER BY created_at LIMIT 20`;
  let captured = 0;
  for (const row of rows) {
    const outcome = row.status === "authorized" ? await completeWithTip(row, business, AUTO_CAPTURE_ACTOR, 0) : await advance(row, business, AUTO_CAPTURE_ACTOR);
    if (outcome.state === "approved") { await finishTerminalApproval(outcome, String(row.order_id), business, AUTO_CAPTURE_ACTOR); captured += 1; }
  }
  return { captured };
}

/** Terminal charges the POS could not put on an order, for a manager to refund or record. */
export async function listTerminalSalesNeedingReview(business: OrderingBusiness) {
  await ensureSchema();
  return getSql()`SELECT session.id,session.order_id,orders.display_number,session.amount_cents,session.provider_transaction_reference,session.status_message,session.created_at
    FROM ordering_mx_checkout_sessions session JOIN ordering_orders orders ON orders.id=session.order_id
    WHERE session.business=${business} AND session.channel='terminal' AND session.status='needs_review' ORDER BY session.created_at`;
}

/** A manager refunded or recorded the charge in MX; the order can take payments again. */
export async function resolveTerminalSaleReview(input: { business: OrderingBusiness; sessionId: string; note: string; actor: OrderingActor }) {
  if (!canManagePos(input.actor)) throw new PaymentConflictError("Only a manager can resolve a terminal charge.");
  const note = input.note.trim().slice(0, 500);
  if (note.length < 3) throw new PaymentConflictError("Say what was done in MX (for example, \"refunded in MX\").");
  await ensureSchema();
  const rows = await getSql()`UPDATE ordering_mx_checkout_sessions SET status='resolved',reviewed_by=${input.actor.id},reviewed_at=NOW(),review_note=${note} WHERE id=${input.sessionId} AND business=${input.business} AND channel='terminal' AND status='needs_review' RETURNING id`;
  if (!rows.length) throw new PaymentConflictError("That terminal charge is not waiting for review.");
}

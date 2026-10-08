// Card refunds and voids through Dharma / MX Merchant for payments the POS
// took with MX (phone orders keyed in now, the Dejavoo Z6 later).
//
// The processor call cannot be rolled back, so every attempt is logged on a
// connection outside the order's database transaction. If MX approves and
// the POS update then fails, the approval is still on record and a retry
// applies it instead of refunding the customer twice.
import { randomUUID } from "node:crypto";
import { getSql, outsideTransaction } from "@/lib/db";
import { MxMerchantError, newReplayId, refundMxPaymentPartially, voidOrRefundMxPayment } from "@/lib/mx-merchant";

let ready: Promise<void> | null = null;
function ensureSchema() {
  ready ??= outsideTransaction(async () => {
    await getSql()`CREATE TABLE IF NOT EXISTS ordering_mx_reversal_attempts(
      id UUID PRIMARY KEY,
      business TEXT NOT NULL,
      order_id UUID NOT NULL,
      source_transaction_id UUID NOT NULL,
      source_reference TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      full_reversal BOOLEAN NOT NULL,
      replay_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','failed','applied')),
      kind TEXT NOT NULL DEFAULT '',
      mx_reference TEXT NOT NULL DEFAULT '',
      mx_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await getSql()`CREATE INDEX IF NOT EXISTS ordering_mx_reversal_source_idx ON ordering_mx_reversal_attempts(source_transaction_id, status)`;
  }).catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}
const outside = <T,>(run: () => Promise<T>) => outsideTransaction(run);

/**
 * Amount already sent to MX for this payment but not yet recorded on the
 * order (in flight or approved). One approval matching `reusableAmountCents`
 * is left out, because this request will record it instead of calling MX.
 */
export async function unappliedMxReversalCents(sourceTransactionId: string, reusableAmountCents: number) {
  await ensureSchema();
  const rows = await outside(() => getSql()`SELECT status,amount_cents FROM ordering_mx_reversal_attempts WHERE source_transaction_id=${sourceTransactionId} AND status IN ('pending','approved')`);
  let total = rows.reduce((sum, row) => sum + Number(row.amount_cents), 0);
  if (rows.some((row) => row.status === "approved" && Number(row.amount_cents) === reusableAmountCents)) total -= reusableAmountCents;
  return total;
}

export type MxReversalResult = { attemptId: string; kind: "void" | "refund"; reference: string; details: Record<string, unknown> };

/**
 * Sends the reversal to MX, or reuses an MX approval that was never recorded
 * locally (same payment and amount). Throws if MX declines or is unreachable.
 */
export async function reverseMxPayment(input: {
  business: string;
  orderId: string;
  sourceTransactionId: string;
  sourceReference: string;
  amountCents: number;
  fullReversal: boolean;
  actorId: string;
  /** For a terminal payment, the authorization its charge completed. */
  authorizationReference?: string;
}): Promise<MxReversalResult> {
  await ensureSchema();
  if (!input.sourceReference) throw new MxMerchantError("This card payment has no MX transaction reference, so it must be refunded in MX Merchant.");
  const leftover = (await outside(() => getSql()`SELECT id,kind,mx_reference,mx_response FROM ordering_mx_reversal_attempts
    WHERE source_transaction_id=${input.sourceTransactionId} AND status='approved' AND amount_cents=${input.amountCents} ORDER BY created_at LIMIT 1`))[0];
  if (leftover)
    return { attemptId: String(leftover.id), kind: leftover.kind === "void" ? "void" : "refund", reference: String(leftover.mx_reference), details: { reusedApproval: true } };
  const inFlight = (await outside(() => getSql()`SELECT 1 FROM ordering_mx_reversal_attempts WHERE source_transaction_id=${input.sourceTransactionId} AND status='pending' AND created_at>NOW()-INTERVAL '2 minutes' LIMIT 1`))[0];
  if (inFlight) throw new MxMerchantError("A refund for this card payment is already being processed. Wait a moment and refresh.");

  const attemptId = randomUUID(), replayId = newReplayId();
  await outside(() => getSql()`INSERT INTO ordering_mx_reversal_attempts(id,business,order_id,source_transaction_id,source_reference,amount_cents,full_reversal,replay_id,created_by)
    VALUES(${attemptId},${input.business},${input.orderId},${input.sourceTransactionId},${input.sourceReference},${input.amountCents},${input.fullReversal},${replayId},${input.actorId})`);
  try {
    const result = input.fullReversal
      ? await voidOrRefundMxPayment(input.sourceReference)
      : await refundMxPaymentPartially({ paymentId: input.sourceReference, amountCents: input.amountCents, replayId });
    const payment = result.payment;
    // A full void keeps the original MX id; give the local record its own unique reference.
    const reference = String((result.kind === "refund" && !input.fullReversal && payment.id) || `${input.sourceReference}:${result.kind}:${attemptId.slice(0, 8)}`);
    // Voiding a terminal charge puts its authorization's hold back on the card (seen in the MX sandbox), so release that too.
    // The charge is already voided; a failure here only leaves a hold that MX drops after 7 days.
    let authorizationReleased: boolean | null = null;
    if (result.kind === "void" && input.authorizationReference) {
      authorizationReleased = await voidOrRefundMxPayment(input.authorizationReference).then(() => true, (error) => {
        console.error(`MX authorization ${input.authorizationReference} was not released after voiding ${input.sourceReference}`, error);
        return false;
      });
    }
    const summary = { status: payment.status ?? null, id: payment.id ?? null, authCode: payment.authCode ?? null, amount: payment.amount ?? null, authorizationReleased };
    await outside(() => getSql()`UPDATE ordering_mx_reversal_attempts SET status='approved',kind=${result.kind},mx_reference=${reference},mx_response=${JSON.stringify(summary)}::jsonb,updated_at=NOW() WHERE id=${attemptId}`);
    return { attemptId, kind: result.kind, reference, details: { mx: summary, replayId } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "MX Merchant could not process the refund.";
    await outside(() => getSql()`UPDATE ordering_mx_reversal_attempts SET status='failed',error=${message.slice(0, 500)},updated_at=NOW() WHERE id=${attemptId}`);
    throw error instanceof MxMerchantError ? error : new MxMerchantError(message);
  }
}

/** Marks an MX approval as recorded on the order. Runs inside the order's transaction, so it only sticks if that commits. */
export async function markMxReversalApplied(attemptId: string) {
  await getSql()`UPDATE ordering_mx_reversal_attempts SET status='applied',updated_at=NOW() WHERE id=${attemptId}`;
}

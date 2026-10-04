import { getSql } from "@/lib/db";
import {
  assertHelcimTransactionMatches,
  HelcimError,
  retrieveHelcimCardTransaction,
  safeEqual,
  sha256,
  validateHelcimPayResponse,
} from "@/lib/helcim";

export type HelcimCheckoutSession = {
  amount_cents: number | string;
  client_mutation_id: string;
  secret_hash: string;
  secret_token?: string | null;
};

/**
 * Verifies a HelcimPay.js approval for a checkout session without trusting the
 * browser: the response hash must be signed with the checkout secret that only
 * the server holds, and the transaction is then fetched from Helcim's API and
 * must be an approved USD purchase for exactly the session amount.
 */
export async function verifyHelcimCheckoutApproval(input: {
  session: HelcimCheckoutSession;
  data: unknown;
  hash: string;
  /** Only for checkouts started before secrets were kept server-side. */
  legacyClientSecret?: string;
}) {
  let secret = String(input.session.secret_token || "");
  if (!secret) {
    const legacy = String(input.legacyClientSecret || "");
    if (!legacy || !safeEqual(String(input.session.secret_hash), sha256(legacy)))
      throw new HelcimError("Helcim checkout verification failed.");
    secret = legacy;
  }
  const response = validateHelcimPayResponse(input.data, input.hash, secret);
  const reference = String(response.transactionId || response.id || "");
  if (!reference)
    throw new HelcimError("Helcim did not return a transaction reference.");

  // A real approval may only ever pay for the checkout it was made in.
  const reused = (
    await getSql()`SELECT 1 FROM ordering_payment_transactions WHERE provider='helcim' AND provider_transaction_reference=${reference} AND client_mutation_id<>${String(input.session.client_mutation_id)} LIMIT 1`
  )[0];
  if (reused)
    throw new HelcimError("This Helcim payment was already applied to another order.");

  const transaction = await retrieveHelcimCardTransaction(reference);
  assertHelcimTransactionMatches(
    transaction,
    reference,
    Number(input.session.amount_cents),
  );
  const digits = String(
    transaction.cardNumber || response.cardNumber || "",
  ).replace(/\D/g, "");
  return {
    reference,
    brand: String(transaction.cardType || response.cardType || "").slice(0, 40),
    last4: digits.slice(-4),
    approvalCode: String(
      transaction.approvalCode || response.approvalCode || "",
    ).slice(0, 80),
  };
}

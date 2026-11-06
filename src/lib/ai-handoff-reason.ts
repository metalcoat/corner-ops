// Why an AI phone call was handed to staff, in words a cashier reads at a glance on the POS popup (Chris,
// 2026-11-06). Stored reasons are either a secure-payment failure code or the AI's own short sentence.

const PAYMENT_FAILURES: Record<string, string> = {
  card_recognition_failed: "Card payment failed twice: couldn't understand the card number. Take the card on the phone.",
  expiration_recognition_failed: "Card payment failed twice: couldn't understand the expiration date. Take the card on the phone.",
  security_code_recognition_failed: "Card payment failed twice: couldn't understand the security code. Take the card on the phone.",
  billing_zip_recognition_failed: "Card payment failed twice: couldn't understand the billing zip code. Take the card on the phone.",
  provider_payment_failed: "Card payment failed: the card was declined or the payment service didn't answer. Nothing was charged; take the card on the phone.",
  claim_failed: "Card payment couldn't start: the payment line couldn't find this order. Take the card on the phone.",
  recognition_failed: "Card payment failed twice: couldn't understand the card details. Take the card on the phone.",
};

export function paymentFailureReason(code: string) {
  return PAYMENT_FAILURES[code] || `Card payment failed (${code.replace(/_/g, " ")}). Take the card on the phone.`;
}

// Set by prepareVoicePayment while the caller is on the automated card line: nothing for staff to do yet.
export const cardPaymentInProgress = (stored: string | null | undefined) => /^Secure (?:sandbox )?voice payment$/i.test(String(stored || "").trim());

export function aiHandoffReason(stored: string | null | undefined) {
  const reason = String(stored || "").trim();
  if (!reason) return "The AI transferred this call to the deli phones.";
  if (cardPaymentInProgress(reason)) return "The caller is paying by card on the automated line. Nothing to do unless it fails.";
  const payment = /^Secure payment failed: (\w+)$/.exec(reason);
  if (payment) return paymentFailureReason(payment[1]);
  if (/^Gemini session ended\.?$/i.test(reason)) return "The AI line dropped mid-call; the caller was sent to the deli phones.";
  return reason;
}

"use client";

import { useState } from "react";

export type MxPaymentInitialization = {
  token: string;
  paymentUrl: string;
  merchantId: string;
  amount: number;
  replayId: number;
  customerName?: string;
  avsStreet?: string;
  avsZip?: string;
  requireAvsZip?: boolean;
  requireAvsStreet?: boolean;
  /** Keyed payments are never card-present: phone orders on the POS, or online orders (src/lib/mx-presentment.ts). */
  cardPresent?: boolean;
  authorizationIndicator?: string;
  posData?: Record<string, string>;
  /** POS phone orders: cards the attached customer saved, and whether a keyed card can be saved for them. */
  savedCards?: Array<{ id: string; brand: string; last4: string }>;
  canSaveCard?: boolean;
};

export default function MxKeyedPaymentDialog({
  payment: initialPayment,
  onApproved,
  onCancel,
  onDeclined,
  saveCard,
  onChargeSaved,
}: {
  payment: MxPaymentInitialization;
  onApproved: (replayId: number) => Promise<void>;
  onCancel: () => void;
  /**
   * After a decline, a fresh payment attempt (new replayId) for trying another
   * card: MX rejects a second card on the same replayId. Not called when MX
   * didn't answer (the charge may have gone through).
   */
  onDeclined?: () => Promise<MxPaymentInitialization | null>;
  /**
   * Offer "Save this card": after an approval the dialog sends the same card
   * straight to MX's vault (never to Corner Ops) with a limited-use token from
   * start(), then calls saved() so the server records MX's token.
   */
  /** Charge one of payment.savedCards instead of typing a card (the caller confirms consent). */
  onChargeSaved?: (savedCardId: string) => Promise<void>;
  saveCard?: {
    label: string;
    /** Staff on a phone order: ticked unless the customer says no, with what to tell them. Online stays the customer's own choice. */
    defaultOn?: boolean;
    notice?: string;
    start: () => Promise<{ token: string; vaultUrl: string; mxCustomerId: string } | null>;
    saved: () => Promise<void>;
  };
}) {
  const [payment, setPayment] = useState(initialPayment);
  const [saveThisCard, setSaveThisCard] = useState(Boolean(saveCard?.defaultOn));
  const [consented, setConsented] = useState(false);
  async function chargeSaved(id: string) {
    if (!onChargeSaved || busy) return;
    setBusy(true);
    setError("");
    try {
      await onChargeSaved(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The saved card could not be charged.");
      setBusy(false);
    }
  }
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [billingZip, setBillingZip] = useState(payment.avsZip || "");
  const [billingStreet, setBillingStreet] = useState(payment.avsStreet || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function updateExpiry(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 4);
    setExpiry(
      digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits,
    );
  }
  function updateCardNumber(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 19);
    const groups = /^3[47]/.test(digits)
      ? [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)]
      : [
          digits.slice(0, 4),
          digits.slice(4, 8),
          digits.slice(8, 12),
          digits.slice(12, 16),
          digits.slice(16, 19),
        ];
    setNumber(groups.filter(Boolean).join(" "));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const digits = number.replace(/\D/g, "");
      const match = expiry.match(/^\s*(\d{1,2})\s*[/\-]\s*(\d{2}|\d{4})\s*$/);
      if (
        digits.length < 13 ||
        digits.length > 19 ||
        !match ||
        cvv.replace(/\D/g, "").length < 3
      )
        throw new Error(
          "Enter a valid card number, expiration, and security code.",
        );
      if (payment.requireAvsZip && billingZip.replace(/\D/g, "").length < 5)
        throw new Error("Enter the card billing ZIP code.");
      if (payment.requireAvsStreet && billingStreet.trim().length < 1)
        throw new Error("Enter the card billing street address.");
      const year = match[2].length === 2 ? `20${match[2]}` : match[2];
      const response = await fetch(
        `${payment.paymentUrl}?token=${encodeURIComponent(payment.token)}&echo=true`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            merchantId: payment.merchantId,
            tenderType: "Card",
            paymentType: "Sale",
            amount: payment.amount,
            replayId: payment.replayId,
            source: "API",
            customerName: payment.customerName,
            ...(payment.cardPresent !== undefined ? { cardPresent: payment.cardPresent } : {}),
            ...(payment.authorizationIndicator ? { authorizationIndicator: payment.authorizationIndicator } : {}),
            ...(payment.posData ? { posData: payment.posData } : {}),
            cardAccount: {
              number: digits,
              expiryMonth: match[1].padStart(2, "0"),
              expiryYear: year,
              cvv: cvv.replace(/\D/g, ""),
              ...(billingStreet ? { avsStreet: billingStreet.trim() } : {}),
              ...(billingZip ? { avsZip: billingZip.replace(/\s/g, "") } : {}),
            },
          }),
        },
      );
      const result = (await response.json().catch(() => null)) as {
        status?: string;
        message?: string;
        authMessage?: string;
      } | null;
      if (
        !response.ok ||
        !String(result?.status || "")
          .toLowerCase()
          .includes("approve")
      ) {
        // MX answered with a decline: the next card needs a new attempt.
        if (result && onDeclined) {
          const next = await onDeclined().catch(() => null);
          if (next) setPayment(next);
        }
        throw new Error(
          result?.authMessage || result?.message || "MX declined the payment.",
        );
      }
      if (saveCard && saveThisCard) {
        // The payment is approved; saving is a bonus and never blocks the order.
        try {
          const vault = await saveCard.start();
          if (vault) {
            const saved = await fetch(`${vault.vaultUrl}?token=${encodeURIComponent(vault.token)}&customerid=${encodeURIComponent(vault.mxCustomerId)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                number: digits,
                expiryMonth: match[1].padStart(2, "0"),
                expiryYear: year,
                ...(billingZip ? { avsZip: billingZip.replace(/\s/g, "") } : {}),
                ...(billingStreet ? { avsStreet: billingStreet.trim() } : {}),
                ...(payment.customerName ? { name: payment.customerName } : {}),
              }),
            });
            if (saved.ok) await saveCard.saved();
          }
        } catch {
          // The card wasn't saved; the customer can add it from their account.
        }
      }
      setNumber("");
      setExpiry("");
      setCvv("");
      await onApproved(payment.replayId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Payment could not be completed.",
      );
      setBusy(false);
    }
  }
  return (
    <div className="mxPaymentBackdrop" role="presentation">
      <form
        className="mxPaymentDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mx-payment-title"
        onSubmit={submit}
      >
        <h2 id="mx-payment-title">Secure card payment</h2>
        <strong>${payment.amount.toFixed(2)}</strong>
        <label>
          Card number
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="cc-number"
            value={number}
            onChange={(e) => updateCardNumber(e.target.value)}
            placeholder="4242 4242 4242 4242"
          />
        </label>
        <div>
          <label>
            Expiration
            <input
              inputMode="numeric"
              autoComplete="cc-exp"
              value={expiry}
              onChange={(e) => updateExpiry(e.target.value)}
              placeholder="MM/YY"
            />
          </label>
          <label>
            Security code
            <input
              inputMode="numeric"
              autoComplete="cc-csc"
              value={cvv}
              onChange={(e) => setCvv(e.target.value)}
              placeholder="CVV"
            />
          </label>
        </div>
        {payment.requireAvsStreet && (
          <label>
            Billing street address
            <input
              autoComplete="address-line1"
              value={billingStreet}
              onChange={(e) => setBillingStreet(e.target.value.slice(0, 120))}
              placeholder="Street address"
              required
            />
          </label>
        )}
        {payment.requireAvsZip && (
          <label>
            Billing ZIP code
            <input
              inputMode="numeric"
              autoComplete="postal-code"
              value={billingZip}
              onChange={(e) =>
                setBillingZip(
                  e.target.value.replace(/[^\d-]/g, "").slice(0, 10),
                )
              }
              placeholder="ZIP code"
              required
            />
          </label>
        )}
        {onChargeSaved && (payment.savedCards || []).length > 0 && (
          <fieldset className="mxSavedCards">
            <legend>Saved cards</legend>
            <label className="mxSaveCard">
              <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
              The customer said OK to charge their saved card
            </label>
            {(payment.savedCards || []).map((card) => (
              <button type="button" key={card.id} disabled={busy || !consented} onClick={() => void chargeSaved(card.id)}>
                CHARGE {card.brand.toUpperCase()} ····{card.last4}
              </button>
            ))}
          </fieldset>
        )}
        {saveCard && (
          <label className="mxSaveCard">
            <input type="checkbox" checked={saveThisCard} onChange={(event) => setSaveThisCard(event.target.checked)} />
            {saveCard.label}
          </label>
        )}
        {saveCard?.notice && <small className="mxSaveCardNotice">{saveCard.notice}</small>}
        <small>
          Card details are sent directly to MX Merchant and never pass through
          Corner Deli servers.
        </small>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>
            CANCEL
          </button>
          <button disabled={busy}>{busy ? "PROCESSING…" : "PAY"}</button>
        </footer>
      </form>
    </div>
  );
}

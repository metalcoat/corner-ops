"use client";

import { useEffect, useMemo, useState } from "react";

type Item = { id: string; item_name_snapshot: string; quantity: number; cancelled_quantity?: number };
type Tender = { id: string; tender_type: string; transaction_type: string; status: string; amount_cents: number };
type Quote = { orderReductionCents: number; refundRequiredCents: number; discountCents: number; taxCents: number; customerId?: string | null };
type Resolution = "forgot" | "full_refund" | "minor" | "medium" | "large";

const money = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
const creditPercent: Partial<Record<Resolution, number>> = { minor: 10, medium: 30, large: 60 };
const resolutionReason: Record<Resolution, string> = {
  forgot: "Item was forgotten",
  full_refund: "Full item refund",
  minor: "Minor item issue — 10% future-order credit",
  medium: "Medium item issue — 30% future-order credit",
  large: "Large item issue — 60% future-order credit",
};

export default function ItemCancellationPanel({ orderId, item, onDone, onClose }: {
  orderId: string;
  item: Item;
  onDone: (result?: { kind: "cancelled" | "courtesy_credit"; creditCents?: number }) => Promise<void>;
  onClose: () => void;
}) {
  const available = Number(item.quantity) - Number(item.cancelled_quantity || 0);
  const [quantity, setQuantity] = useState(1);
  const [resolution, setResolution] = useState<Resolution>("forgot");
  const [reason, setReason] = useState(resolutionReason.forgot);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [tenderId, setTenderId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQuote(null);
    const timer = window.setTimeout(async () => {
      try {
        const [quoteResponse, paymentResponse] = await Promise.all([
          fetch(`/api/ordering/order-center/${orderId}/items/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "quote", itemId: item.id, quantity }) }),
          fetch(`/api/ordering/orders/${orderId}/payments?business=Corner%20Deli`),
        ]);
        const quoteBody = await quoteResponse.json();
        const paymentBody = await paymentResponse.json();
        if (!quoteResponse.ok) throw new Error(quoteBody.error || "The item resolution could not be priced.");
        setQuote(quoteBody);
        const payments = (paymentBody.tenders || []).filter((row: Tender) => row.transaction_type === "payment" && row.status === "approved");
        setTenders(payments);
        setTenderId((current) => current || payments[0]?.id || "");
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The item resolution could not be priced.");
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [item.id, orderId, quantity]);

  const courtesyCreditCents = useMemo(() => {
    const percent = creditPercent[resolution];
    if (!quote || !percent) return 0;
    const rounded = Math.round((quote.orderReductionCents * percent / 100) / 25) * 25;
    return Math.min(quote.orderReductionCents, Math.max(25, rounded));
  }, [quote, resolution]);
  const courtesyCredit = courtesyCreditCents > 0;

  function choose(next: Resolution) {
    setResolution(next);
    setReason(resolutionReason[next]);
    setError("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!quote) return;
    setBusy(true);
    setError("");
    try {
      if (courtesyCredit) {
        if (!quote.customerId) throw new Error("Attach this order to a customer before issuing future-order credit.");
        const response = await fetch("/api/ordering/customer-credits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: quote.customerId, orderId, amountCents: courtesyCreditCents, reason }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "The future-order credit could not be issued.");
        await onDone({ kind: "courtesy_credit", creditCents: courtesyCreditCents });
        return;
      }
      const response = await fetch(`/api/ordering/order-center/${orderId}/items/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: item.id, quantity, reason, paymentTransactionId: quote.refundRequiredCents ? tenderId : undefined, refundMethod: "original", clientMutationId: crypto.randomUUID() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The item refund could not be completed.");
      await onDone({ kind: "cancelled" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The item resolution could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ocItemCancel" onSubmit={submit}>
      <h3>Resolve item problem</h3>
      <strong>{item.item_name_snapshot}</strong>
      <label>Quantity<select value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}>{Array.from({ length: available }, (_, index) => <option key={index + 1}>{index + 1}</option>)}</select></label>
      <div className="ocResolutionChoices" role="group" aria-label="Item resolution">
        <button type="button" className={resolution === "forgot" ? "selected" : ""} onClick={() => choose("forgot")}><strong>WE FORGOT IT</strong><span>Remove item and refund it</span></button>
        <button type="button" className={resolution === "full_refund" ? "selected" : ""} onClick={() => choose("full_refund")}><strong>FULL REFUND</strong><span>Remove and refund full item charge</span></button>
        <button type="button" className={resolution === "minor" ? "selected" : ""} onClick={() => choose("minor")}><strong>MINOR · 10%</strong><span>{money(courtesyCreditCents)} future credit</span></button>
        <button type="button" className={resolution === "medium" ? "selected" : ""} onClick={() => choose("medium")}><strong>MEDIUM · 30%</strong><span>{money(courtesyCreditCents)} future credit</span></button>
        <button type="button" className={resolution === "large" ? "selected" : ""} onClick={() => choose("large")}><strong>LARGE · 60%</strong><span>{money(courtesyCreditCents)} future credit</span></button>
      </div>
      <label>Reason<textarea autoFocus maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      {quote && <div className="cancelQuote"><span>Item charge with tax <b>{money(quote.orderReductionCents)}</b></span>{courtesyCredit ? <span>Future-order credit <b>{money(courtesyCreditCents)}</b></span> : <><span>Checkout adjustment <b>−{money(quote.orderReductionCents)}</b></span><span>Refund required <b>{money(quote.refundRequiredCents)}</b></span></>}</div>}
      {!courtesyCredit && quote && quote.refundRequiredCents > 0 && <label>Payment being refunded<select value={tenderId} onChange={(event) => setTenderId(event.target.value)}><option value="">Choose original payment</option>{tenders.map((tender) => <option key={tender.id} value={tender.id}>{tender.tender_type.replaceAll("_", " ")} · {money(tender.amount_cents)}</option>)}</select></label>}
      {courtesyCredit && !quote?.customerId && <p className="ocDialogError">A customer account is required for future-order credit.</p>}
      {error && <p className="ocDialogError" role="alert">{error}</p>}
      <div><button type="button" disabled={busy} onClick={onClose}>BACK</button><button className={courtesyCredit ? "primary" : "danger"} disabled={busy || reason.trim().length < 3 || !quote || (courtesyCredit ? !quote.customerId : quote.refundRequiredCents > 0 && !tenderId)}>{busy ? "SAVING…" : courtesyCredit ? `ISSUE ${money(courtesyCreditCents)} CREDIT` : "REMOVE & REFUND ITEM"}</button></div>
    </form>
  );
}

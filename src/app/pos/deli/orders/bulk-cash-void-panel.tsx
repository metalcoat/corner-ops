"use client";

import { useState } from "react";

type Preview = {
  from: string;
  to: string;
  count: number;
  totalCents: number;
  previewToken: string;
  orders: Array<{ id: string; displayNumber: string; customerName: string; paidAt: string; amountCents: number }>;
};
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const paidDate = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export default function BulkCashVoidPanel({ onClose, onComplete }: { onClose: () => void; onComplete: () => Promise<void> }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  async function loadPreview() {
    setBusy(true); setError(""); setResult(""); setPreview(null); setConfirmation("");
    try {
      const response = await fetch(`/api/ordering/order-center/bulk-cash-void?${new URLSearchParams({ from, to })}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not preview cash orders.");
      setPreview(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not preview cash orders."); }
    finally { setBusy(false); }
  }

  async function execute() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/ordering/order-center/bulk-cash-void", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, to, previewToken: preview.previewToken, reason, confirmation }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not void cash orders.");
      setResult(`${body.voided} order${body.voided === 1 ? "" : "s"} voided; ${money(body.reversedCents)} in cash payments reversed in the POS.${body.skipped.length ? ` ${body.skipped.length} skipped: ${body.skipped.map((item: { displayNumber: string; reason: string }) => `#${item.displayNumber} (${item.reason})`).join(", ")}` : ""}`);
      setPreview(null); setConfirmation("");
      await onComplete();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not void cash orders."); }
    finally { setBusy(false); }
  }

  const phrase = preview ? `VOID ${preview.count} CASH ORDERS` : "";
  return <div className="ocBackdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="ocDetail ocBulkCash" role="dialog" aria-modal="true" aria-label="Bulk void cash paid orders">
      <header><h2>Bulk void cash paid orders · development</h2><button type="button" disabled={busy} onClick={onClose}>Close</button></header>
      <p>Manager test tool. Matches orders by the date their cash payment was completed, in Eastern time. Only fully paid, cash-only orders qualify. The POS will reverse their cash payment records and void the orders. This does not physically return cash to customers or print anything.</p>
      <div className="ocBulkDates">
        <label>Paid from <input type="date" value={from} onChange={event => { setFrom(event.target.value); setPreview(null); setConfirmation(""); }} /></label>
        <label>Paid through <input type="date" value={to} onChange={event => { setTo(event.target.value); setPreview(null); setConfirmation(""); }} /></label>
        <button type="button" disabled={busy} onClick={() => void loadPreview()}>{busy ? "Working…" : "Preview matching orders"}</button>
      </div>
      {error && <p role="alert" className="ocDialogError">{error}</p>}
      {result && <p role="status" className="ocBulkResult">{result}</p>}
      {preview && <>
        <p className="ocBulkSummary"><strong>{preview.count} orders · {money(preview.totalCents)}</strong> in cash payments</p>
        <div className="ocBulkList">{preview.orders.map(order => <div key={order.id}><strong>#{order.displayNumber}</strong><span>{order.customerName || "Guest"}</span><span>{paidDate(order.paidAt)}</span><b>{money(order.amountCents)}</b></div>)}</div>
        {preview.count > 0 && <div className="ocBulkConfirm">
          <label>Reason for all voids <textarea value={reason} maxLength={300} onChange={event => setReason(event.target.value)} placeholder="Example: Clearing cash transactions from POS testing" /></label>
          <label>Type <strong>{phrase}</strong> to confirm <input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></label>
          <button type="button" className="danger" disabled={busy || reason.trim().length < 3 || confirmation !== phrase} onClick={() => void execute()}>{busy ? "Voiding…" : `Void ${preview.count} cash orders`}</button>
        </div>}
      </>}
    </section>
  </div>;
}

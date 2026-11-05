"use client";
import { useEffect, useState } from "react";
import { randomId } from "@/app/client-id";
import type { orderSearchDetail } from "@/lib/ordering-order-search";
import { cashRefundBecomesCredit } from "@/lib/ordering-refund-policy";

type Detail = NonNullable<Awaited<ReturnType<typeof orderSearchDetail>>>;
type Mode = "amount" | "item" | "void";
type Method = "original" | "store_credit";
type Quote = { itemName: string; refundRequiredCents: number; orderReductionCents: number };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const toCents = (value: string) => Math.round(Number(value) * 100);
const voidable = ["draft", "sent_to_kitchen", "in_progress", "ready", "completed"];

/** Refund (an amount, or items) and void, from the manager portal. Every action is confirmed with the manager's own PIN. */
export default function MoneyActions({ order, onChange }: { order: Detail; onChange: (order: Detail) => void }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [tenderId, setTenderId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("original");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [voidRefund, setVoidRefund] = useState<Method | "none">("original");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [requestId, setRequestId] = useState("");

  const items = order.items.filter((item) => item.quantity > item.cancelled);
  const item = items.find((row) => row.id === itemId);
  const tender = order.refundable.find((row) => row.id === tenderId);
  const amountCents = mode === "item" ? quote?.refundRequiredCents ?? 0 : mode === "void" ? order.refundable.reduce((sum, row) => sum + row.remainingCents, 0) : toCents(amount);
  const canRefund = order.refundable.length > 0 && (order.status !== "draft" || order.voided);
  const canRefundItems = !order.voided && order.status !== "cancelled" && order.status !== "draft" && items.length > 0;
  const canVoid = !order.voided && voidable.includes(order.status);
  // Owner rule: part of a cash order is left as store credit when there's a customer to give it to.
  const forcedCredit = mode !== "void" && tender && cashRefundBecomesCredit({ tenderType: tender.tenderType, wholeOrder: amountCents >= order.paidCents, customerId: order.hasCustomer ? "yes" : null });
  const credit = method === "store_credit" || Boolean(forcedCredit);

  const start = (next: Mode) => {
    setMode(next); setReviewing(false); setError(""); setDone(""); setReason(""); setPin(""); setMethod("original"); setQuote(null); setRequestId(randomId());
    const first = order.refundable[0];
    setTenderId(first?.id || ""); setAmount(first ? (first.remainingCents / 100).toFixed(2) : "");
    setItemId(items[0]?.id || ""); setQuantity("1"); setVoidRefund(order.refundable.length ? "original" : "none");
  };
  const close = () => { setMode(null); setReviewing(false); setPin(""); setError(""); };

  // Item refunds: ask the server what voiding that many would give back.
  useEffect(() => {
    if (mode !== "item" || !itemId) return;
    let live = true;
    setQuote(null);
    void (async () => {
      const response = await fetch(`/api/employee/order-search/${order.id}/refund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "quote", itemId, quantity: Number(quantity) }) }).catch(() => null);
      const body = response ? await response.json().catch(() => ({})) : {};
      if (!live) return;
      if (response?.ok) {
        setQuote(body); setError("");
        const enough = order.refundable.find((row) => row.remainingCents >= body.refundRequiredCents);
        if (enough) setTenderId(enough.id);
      } else setError(body.error || "Could not work out the refund for that item.");
    })();
    return () => { live = false; };
  }, [mode, itemId, quantity, order.id, order.refundable]);

  const problem = (() => {
    if (reason.trim().length < 3) return "Enter a reason.";
    if (mode === "amount") {
      if (!tender) return "Choose a payment.";
      if (!(amountCents > 0) || amountCents > tender.remainingCents) return `Enter up to ${money(tender.remainingCents)}.`;
    }
    if (mode === "item") {
      if (!item) return "Choose an item.";
      const max = item.quantity - item.cancelled, count = Number(quantity);
      if (!Number.isInteger(count) || count < 1 || count > max) return `Choose 1 to ${max}.`;
      if (!quote) return "Working out the refund…";
      if (quote.refundRequiredCents > 0 && (!tender || tender.remainingCents < quote.refundRequiredCents)) return "Choose a payment with enough left on it.";
    }
    if (credit && mode !== "void" && amountCents > 0 && !order.hasCustomer) return "No customer on this order for store credit.";
    if (mode === "void" && voidRefund === "store_credit" && !order.hasCustomer) return "No customer on this order for store credit.";
    return "";
  })();

  const where = credit ? "store credit" : tender ? tender.label : "";
  const summary = mode === "amount" ? `Refund ${money(amountCents)} to ${where} on order #${order.number}`
    : mode === "item" ? `Void ${quantity}× ${item?.name || "item"}${amountCents > 0 ? ` and refund ${money(amountCents)} to ${where}` : " (nothing to refund)"}`
    : `Void order #${order.number}${voidRefund === "none" || amountCents === 0 ? "" : ` and refund ${money(amountCents)} ${voidRefund === "store_credit" ? "as store credit" : `to ${order.refundable.map((row) => row.label).join(" + ")}`}`}`;

  async function confirm() {
    setBusy(true); setError("");
    try {
      const url = `/api/employee/order-search/${order.id}/${mode === "void" ? "void" : "refund"}`;
      const payload = mode === "void" ? { reason, refund: voidRefund, pin, clientMutationId: requestId }
        : { action: mode, transactionId: tenderId, amountCents, itemId, quantity: Number(quantity), method, reason, pin, clientMutationId: requestId };
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // A wrong PIN can be retried as the same request; anything else needs a fresh one.
        if (response.status !== 403) setRequestId(randomId());
        throw new Error(body.error || "That didn't go through.");
      }
      if (body.order) onChange(body.order);
      const failed = (body.result?.refunds || []).filter((row: { ok: boolean }) => !row.ok) as Array<{ label: string; amountCents: number; error?: string }>;
      setDone(mode === "void"
        ? `Order voided.${failed.length ? ` Not refunded: ${failed.map((row) => `${money(row.amountCents)} on ${row.label} (${row.error})`).join("; ")}. It shows under "Needs refund or credit" at the POS.` : amountCents > 0 && voidRefund !== "none" ? ` ${money(amountCents)} refunded.` : ""}`
        : `${money(body.result?.amountCents ?? amountCents)} refunded${body.result?.method ? ` to ${body.result.method}` : ""}.`);
      setMode(null); setReviewing(false); setPin("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't go through."); }
    finally { setBusy(false); }
  }

  if (!canRefund && !canRefundItems && !canVoid && !done) return null;
  return (
    <section className="mgrSection osMoney">
      <h2>Refund or void</h2>
      {done && <p className="osDone" role="status">{done}</p>}
      {!mode && <div className="osActions">
        {canRefund && <button type="button" onClick={() => start("amount")}>Refund amount</button>}
        {canRefundItems && <button type="button" onClick={() => start("item")}>Refund items</button>}
        {canVoid && <button type="button" className="danger" onClick={() => start("void")}>Void order</button>}
      </div>}
      {mode && !reviewing && <form className="osForm" onSubmit={(event) => { event.preventDefault(); if (!problem) setReviewing(true); }}>
        <h3>{mode === "amount" ? "Refund an amount" : mode === "item" ? "Refund items" : `Void order #${order.number}`}</h3>
        {mode === "item" && <div className="osFields">
          <label>Item<select value={itemId} onChange={(event) => { setItemId(event.target.value); setQuantity("1"); }}>
            {items.map((row) => <option key={row.id} value={row.id}>{row.quantity - row.cancelled}× {row.name} · {money(row.totalCents)}</option>)}
          </select></label>
          <label>How many<input type="number" inputMode="numeric" min={1} max={item ? item.quantity - item.cancelled : 1} value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        </div>}
        {mode === "item" && quote && <p className="mgrEmpty">Takes {money(quote.orderReductionCents)} off the order · refund {money(quote.refundRequiredCents)}</p>}
        {mode !== "void" && order.refundable.length > 0 && (mode === "amount" || amountCents > 0) && <div className="osFields">
          <label>From payment<select value={tenderId} onChange={(event) => { setTenderId(event.target.value); const next = order.refundable.find((row) => row.id === event.target.value); if (next && mode === "amount") setAmount((next.remainingCents / 100).toFixed(2)); }}>
            {order.refundable.map((row) => <option key={row.id} value={row.id}>{row.label} · {money(row.remainingCents)} left</option>)}
          </select></label>
          {mode === "amount" && <label>Amount<input type="number" inputMode="decimal" min="0.01" step="0.01" max={tender ? tender.remainingCents / 100 : undefined} value={amount} onChange={(event) => setAmount(event.target.value)} /></label>}
          <label>Give back as<select value={forcedCredit ? "store_credit" : method} disabled={Boolean(forcedCredit)} onChange={(event) => setMethod(event.target.value as Method)}>
            <option value="original">{tender ? `Back to ${tender.label}` : "Original payment"}</option>
            <option value="store_credit" disabled={!order.hasCustomer}>Store credit{order.hasCustomer ? "" : " (no customer)"}</option>
          </select></label>
        </div>}
        {mode === "void" && order.refundable.length > 0 && <div className="osFields">
          <label>Money paid ({money(amountCents)})<select value={voidRefund} onChange={(event) => setVoidRefund(event.target.value as Method | "none")}>
            <option value="original">Refund to {order.refundable.map((row) => row.label).join(" + ")}</option>
            <option value="store_credit" disabled={!order.hasCustomer}>Leave as store credit{order.hasCustomer ? "" : " (no customer)"}</option>
            <option value="none">Don&apos;t refund now</option>
          </select></label>
        </div>}
        {forcedCredit && <p className="mgrEmpty">Part of a cash order goes back as store credit for next time (store rule).</p>}
        {!credit && tender?.tenderType === "cash" && mode !== "void" && <p className="mgrEmpty">Cash comes out of the register that took it, which has to be open.</p>}
        {mode === "void" && voidRefund === "none" && order.paidCents > 0 && <p className="mgrEmpty">The money stays on the order and shows under &quot;Needs refund or credit&quot; at the POS until it&apos;s refunded or credited.</p>}
        <label>Reason<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
        {problem && reason && <p className="mgrEmpty">{problem}</p>}
        {error && <p className="mgrError" role="alert">{error}</p>}
        <div className="osActions">
          <button type="button" onClick={close}>Cancel</button>
          <button type="submit" className="primary" disabled={Boolean(problem)}>Review</button>
        </div>
      </form>}
      {mode && reviewing && <form className="osForm osConfirm" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <h3>Confirm</h3>
        <p className="osSummaryLine">{summary}</p>
        <p className="mgrEmpty">Reason: {reason.trim()}</p>
        {!credit && tender?.tenderType === "card" && mode !== "void" && <p className="mgrEmpty">Card refunds go back through MX right away and can&apos;t be undone here.</p>}
        <label>Your PIN<input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(event) => setPin(event.target.value)} autoFocus /></label>
        {error && <p className="mgrError" role="alert">{error}</p>}
        <div className="osActions">
          <button type="button" disabled={busy} onClick={() => { setReviewing(false); setError(""); }}>Back</button>
          <button type="submit" className={mode === "void" ? "danger" : "primary"} disabled={busy || pin.length < 4}>{busy ? "Working…" : mode === "void" ? "Void order" : "Refund"}</button>
        </div>
      </form>}
    </section>
  );
}

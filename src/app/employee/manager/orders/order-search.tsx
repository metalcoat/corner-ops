"use client";
import { useCallback, useEffect, useState } from "react";
import type { orderSearchDetail, searchOrders } from "@/lib/ordering-order-search";
import "../manager-report.css";
import "./order-search.css";

type Results = Awaited<ReturnType<typeof searchOrders>> & { today: string };
type Detail = NonNullable<Awaited<ReturnType<typeof orderSearchDetail>>>;
type Order = Results["orders"][number];

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const when = (iso: string | null) => iso ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "";
const stamp = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
const words = (value: string) => value.replaceAll("_", " ");
const channels: Record<string, string> = { pos: "POS", web: "Online", ai_phone: "AI phone", kiosk: "Kiosk", import: "Import" };
const presets = [{ days: "1", label: "Today" }, { days: "7", label: "7 days" }, { days: "30", label: "30 days" }, { days: "90", label: "90 days" }, { days: "", label: "Dates" }];
const blank = { days: "7", from: "", to: "", name: "", phone: "", last4: "", address: "", number: "", serviceType: "", channel: "", payment: "", tender: "" };
type Form = typeof blank;

function paymentLabel(order: { paymentStatus: string; voidedAt?: string | null; dueCents: number; status: string }) {
  if (order.voidedAt || order.status === "cancelled") return { text: "Voided", tone: "bad" };
  if (order.paymentStatus === "paid") return { text: "Paid", tone: "good" };
  if (order.paymentStatus.includes("refunded")) return { text: words(order.paymentStatus), tone: "bad" };
  return order.dueCents > 0 ? { text: `Owes ${money(order.dueCents)}`, tone: "bad" } : { text: words(order.paymentStatus), tone: "" };
}

export default function OrderSearch() {
  const [form, setForm] = useState<Form>(blank);
  const [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const search = useCallback(async (values: Form) => {
    setLoading(true); setError("");
    const params = new URLSearchParams(Object.entries(values).filter(([key, value]) => value && !(values.days && (key === "from" || key === "to"))));
    window.history.replaceState(null, "", `?${params}`);
    try {
      const response = await fetch(`/api/employee/order-search?${params}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not search orders.");
      setResults(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not search orders."); }
    finally { setLoading(false); }
  }, []);
  // First load runs the search the address bar describes (the last 7 days by default).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = Object.fromEntries(Object.entries(blank).map(([key, value]) => [key, params.get(key) ?? value])) as Form;
    setForm(initial);
    void search(initial);
  }, [search]);

  const open = async (order: Order) => {
    setError("");
    try {
      const response = await fetch(`/api/employee/order-search/${order.id}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not open the order.");
      setSelected(body);
      window.scrollTo({ top: 0 });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the order."); }
  };
  const set = (key: keyof Form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const choosePreset = (days: string) => {
    const next = { ...form, days, from: days ? "" : form.from || results?.filters.from || "", to: days ? "" : form.to || results?.filters.to || "" };
    setForm(next);
    if (days) void search(next);
  };

  if (selected) return <OrderDetail order={selected} onBack={() => setSelected(null)} />;
  return (
    <main className="mgrPage">
      <header className="mgrHeader">
        <h1>Order search</h1>
        <a className="osLink" href="/employee/manager">Daily report</a>
      </header>
      <form className="osForm" onSubmit={(event) => { event.preventDefault(); void search(form); }}>
        <nav className="osPresets" aria-label="Date range">
          {presets.map((preset) => <button type="button" key={preset.label} className={form.days === preset.days ? "active" : ""} aria-pressed={form.days === preset.days} onClick={() => choosePreset(preset.days)}>{preset.label}</button>)}
        </nav>
        {!form.days && <div className="osDates">
          <label>From<input type="date" value={form.from} max={results?.today} onChange={set("from")} /></label>
          <label>To<input type="date" value={form.to} max={results?.today} onChange={set("to")} /></label>
        </div>}
        <div className="osFields">
          <label>Customer name<input value={form.name} onChange={set("name")} autoComplete="off" /></label>
          <label>Phone<input value={form.phone} onChange={set("phone")} inputMode="tel" autoComplete="off" /></label>
          <label>Card last 4<input value={form.last4} onChange={set("last4")} inputMode="numeric" maxLength={4} pattern="\d{4}" autoComplete="off" /></label>
          <label>Delivery address<input value={form.address} onChange={set("address")} autoComplete="off" /></label>
          <label>Order #<input value={form.number} onChange={set("number")} autoComplete="off" /></label>
          <label>Order type<select value={form.serviceType} onChange={set("serviceType")}><option value="">Any</option><option value="pickup">Pickup</option><option value="delivery">Delivery</option><option value="dine_in">Dine in</option></select></label>
          <label>Channel<select value={form.channel} onChange={set("channel")}><option value="">Any</option><option value="pos">POS</option><option value="web">Online</option><option value="ai_phone">AI phone</option></select></label>
          <label>Payment<select value={form.payment} onChange={set("payment")}><option value="">Any</option><option value="paid">Paid</option><option value="owes">Still owes</option><option value="refunded">Refunded</option><option value="voided">Voided</option></select></label>
          <label>Paid by<select value={form.tender} onChange={set("tender")}><option value="">Any</option><option value="cash">Cash</option><option value="card">Card</option><option value="other">Other (gift card, credit…)</option></select></label>
        </div>
        <div className="osActions">
          <button type="submit" className="primary" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
          <button type="button" onClick={() => { setForm(blank); void search(blank); }}>Clear</button>
        </div>
      </form>
      {error && <p className="mgrError" role="alert">{error}</p>}
      {results && <section className="mgrSection">
        <h2>Orders<span>{results.orders.length}{results.truncated ? "+" : ""}</span></h2>
        {results.truncated && <p className="mgrEmpty">Showing the newest {results.orders.length}. Narrow the search to see the rest.</p>}
        {results.orders.length === 0 && <p className="mgrEmpty">No orders match.</p>}
        <div className="osResults">
          {results.orders.map((order) => {
            const pay = paymentLabel(order);
            return <button type="button" key={order.id} className="osResult" onClick={() => void open(order)}>
              <span className="osTop"><strong>#{order.number} · {order.customerName}</strong><b>{money(order.totalCents)}</b></span>
              <small>{when(order.createdAt)} · {words(order.serviceType)} · {channels[order.channel] || order.channel}{order.customerPhone ? ` · ${order.customerPhone}` : ""}</small>
              {order.deliveryAddress && <small>{order.deliveryAddress}</small>}
              <small>Taken by {order.takenBy || "unknown"}{order.sentBy ? ` · sent by ${order.sentBy}` : ""}{order.paidBy ? ` · payment taken by ${order.paidBy}` : ""}</small>
              <span className="osTop"><small>{order.tenders || "No payment"}</small><em className={pay.tone}>{pay.text}</em></span>
            </button>;
          })}
        </div>
      </section>}
    </main>
  );
}

function OrderDetail({ order, onBack }: { order: Detail; onBack: () => void }) {
  const pay = paymentLabel({ ...order, voidedAt: order.voidReason ? "voided" : null });
  return (
    <main className="mgrPage">
      <header className="mgrHeader">
        <button type="button" onClick={onBack}>‹ Results</button>
        <h1>#{order.number}</h1>
      </header>
      <section className="mgrTiles osSummary">
        <article><span>Customer</span><strong>{order.customerName || "Guest"}</strong><small>{order.customerPhone || "No phone"}</small></article>
        <article><span>Order</span><strong>{words(order.serviceType)}</strong><small>{channels[order.channel] || order.channel} · taken by {order.takenBy || "unknown"}</small></article>
        <article><span>Total</span><strong>{money(order.totalCents)}</strong><small>Paid {money(order.paidCents)}{order.tipCents ? ` · tip ${money(order.tipCents)}` : ""}</small></article>
        <article className={pay.tone === "bad" ? "warn" : ""}><span>Status</span><strong>{pay.text}</strong><small>{words(order.status)}</small></article>
      </section>
      {order.deliveryAddress && <p className="mgrEmpty">Deliver to {order.deliveryAddress}{order.deliveryFeeCents ? ` · fee ${money(order.deliveryFeeCents)}` : ""}</p>}
      {order.voidReason && <p className="mgrError">Voided: {order.voidReason}</p>}

      <section className="mgrSection">
        <h2>Timeline<span>{order.trail.length}</span></h2>
        <ol className="osTrail">
          {order.trail.map((entry, index) => <li key={index}>
            <time dateTime={entry.at}>{stamp(entry.at)}</time>
            <div><strong>{entry.label}</strong><small>{entry.who}{entry.detail ? ` · ${entry.detail}` : ""}</small></div>
          </li>)}
        </ol>
      </section>

      <section className="mgrSection">
        <h2>Payments<span>{order.payments.length}</span></h2>
        {order.payments.length === 0 && <p className="mgrEmpty">No payments.</p>}
        {order.payments.map((payment, index) => <div key={index} className="mgrRow">
          <div><strong>{payment.kind === "payment" ? "Payment" : words(payment.kind)} · {payment.card || words(payment.tender)}{payment.status !== "approved" ? ` (${payment.status})` : ""}</strong><small>{when(payment.at)} · {payment.by}{payment.reason ? ` · ${payment.reason}` : ""}</small></div>
          <b className={payment.kind === "payment" ? "" : "bad"}>{payment.kind === "payment" ? "" : "−"}{money(payment.amountCents)}</b>
        </div>)}
      </section>

      <section className="mgrSection">
        <h2>Items<span>{order.items.length}</span></h2>
        {order.items.map((item, index) => <div key={index} className="mgrRow">
          <div><strong>{item.quantity}× {item.name}{item.cancelled ? ` (${item.cancelled} voided)` : ""}</strong>{(item.modifiers.length > 0 || item.addedBy) && <small>{[item.modifiers.join(", "), item.addedBy ? `added by ${item.addedBy}` : ""].filter(Boolean).join(" · ")}</small>}</div>
          <b>{money(item.totalCents)}</b>
        </div>)}
      </section>
    </main>
  );
}

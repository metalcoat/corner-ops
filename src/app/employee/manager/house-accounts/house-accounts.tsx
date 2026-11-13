"use client";
import { useCallback, useEffect, useState } from "react";
import type { HouseAccount, houseAccountDetail } from "@/lib/ordering-house-accounts";
import "../manager-report.css";
import "../orders/order-search.css";
import "./house-accounts.css";

type Detail = NonNullable<Awaited<ReturnType<typeof houseAccountDetail>>>;
type Printer = { id: string; name: string };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money(Math.abs(cents))}`;
const when = (iso: string | null) => iso ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "";
const day = (iso: string | null) => iso ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso)) : "";
/** "12.50" → 1250; null when it isn't an amount. */
const cents = (value: string) => { const amount = Number(value.replace(/[$,\s]/g, "")); return value.trim() && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null; };
const statusLabels: Record<string, string> = { active: "Active", hold: "On hold", closed: "Closed" };
const kindLabels: Record<string, string> = { charge: "Charge", payment: "Payment", credit: "Credit", refund: "Refund", reversal: "Charge reversed", adjustment: "Adjustment" };

async function call<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload as T;
}

export default function HouseAccounts() {
  const [accounts, setAccounts] = useState<HouseAccount[] | null>(null);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<HouseAccount | "new" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const body = await call<{ accounts: HouseAccount[]; printers: Printer[] }>(`/api/employee/house-accounts?${new URLSearchParams({ q: query, closed: showClosed ? "1" : "" })}`);
      setAccounts(body.accounts); setPrinters(body.printers);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load house accounts."); }
  }, [query, showClosed]);
  useEffect(() => { const timer = setTimeout(() => void load(), query ? 250 : 0); return () => clearTimeout(timer); }, [load, query]);
  // ?account=<id> opens that account (the statement page links back here).
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("account"); if (id) setSelected(id); }, []);
  const open = (id: string | null) => { setSelected(id); window.history.replaceState(null, "", id ? `?account=${id}` : window.location.pathname); window.scrollTo({ top: 0 }); };

  if (editing) return <AccountForm account={editing === "new" ? null : editing} onDone={(id) => { setEditing(null); void load(); if (id) open(id); }} />;
  if (selected) return <AccountDetail id={selected} printers={printers} onBack={() => { open(null); void load(); }} onEdit={(account) => setEditing(account)} />;
  const openAccounts = (accounts || []).filter((account) => account.status !== "closed");
  const owed = openAccounts.reduce((sum, account) => sum + Math.max(0, account.balanceCents), 0);
  return (
    <main className="mgrPage">
      <header className="mgrHeader">
        <h1>House accounts</h1>
        <nav className="haLinks"><a className="osLink" href="/employee/manager">Daily report</a><a className="osLink" href="/employee/manager/orders">Order search</a></nav>
      </header>
      <section className="mgrTiles osSummary">
        <article><span>Open accounts</span><strong>{openAccounts.length}</strong><small>{openAccounts.filter((account) => account.status === "hold").length} on hold</small></article>
        <article><span>Owed to the store</span><strong>{money(owed)}</strong><small>{openAccounts.filter((account) => account.balanceCents > 0).length} with a balance</small></article>
      </section>
      <div className="haToolbar">
        <input type="search" placeholder="Search name or phone" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search house accounts" autoComplete="off" />
        <label className="haCheck"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />Show closed</label>
        <button type="button" className="primary" onClick={() => setEditing("new")}>+ New account</button>
      </div>
      {error && <p className="mgrError" role="alert">{error}</p>}
      {accounts && <section className="mgrSection">
        <h2>Accounts<span>{accounts.length}</span></h2>
        {accounts.length === 0 && <p className="mgrEmpty">{query ? "No accounts match." : "No house accounts yet. Add one with + New account."}</p>}
        <div className="osResults">
          {accounts.map((account) => <button type="button" key={account.id} className="osResult" onClick={() => open(account.id)}>
            <span className="osTop"><strong>{account.name}</strong><b className={account.balanceCents > 0 ? "haOwes" : ""}>{money(account.balanceCents)}</b></span>
            <small>{[account.phone, account.email].filter(Boolean).join(" · ") || "No contact details"}</small>
            <span className="osTop"><small>{account.creditLimitCents != null ? `Limit ${money(account.creditLimitCents)}` : "No limit"}{account.lastPaymentAt ? ` · last paid ${day(account.lastPaymentAt)}` : ""}</small>{account.status !== "active" && <em className="bad">{statusLabels[account.status]}</em>}</span>
          </button>)}
        </div>
      </section>}
    </main>
  );
}

function AccountForm({ account, onDone }: { account: HouseAccount | null; onDone: (id: string | null) => void }) {
  const [form, setForm] = useState({ name: account?.name || "", phone: account?.phone || "", email: account?.email || "", notes: account?.notes || "", limit: account?.creditLimitCents != null ? (account.creditLimitCents / 100).toFixed(2) : "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const save = async () => {
    const limit = form.limit.trim() ? cents(form.limit) : null;
    if (form.limit.trim() && limit == null) { setError("Enter the credit limit in dollars, or leave it blank for no limit."); return; }
    setBusy(true); setError("");
    try {
      const body = { name: form.name, phone: form.phone, email: form.email, notes: form.notes, creditLimitCents: limit };
      const result = account ? await call<{ id: string }>(`/api/employee/house-accounts/${account.id}`, { action: "update", ...body }) : await call<{ id: string }>("/api/employee/house-accounts", body);
      onDone(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the account."); }
    finally { setBusy(false); }
  };
  return (
    <main className="mgrPage">
      <header className="mgrHeader"><button type="button" onClick={() => onDone(account?.id || null)}>‹ Back</button><h1>{account ? `Edit ${account.name}` : "New house account"}</h1></header>
      <form className="osForm" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="osFields">
          <label>Name<input value={form.name} onChange={set("name")} required autoComplete="off" placeholder="Mike Russell" /></label>
          <label>Phone<input value={form.phone} onChange={set("phone")} inputMode="tel" autoComplete="off" /></label>
          <label>Email (optional)<input value={form.email} onChange={set("email")} type="email" autoComplete="off" /></label>
          <label>Credit limit (optional)<input value={form.limit} onChange={set("limit")} inputMode="decimal" placeholder="No limit" autoComplete="off" /></label>
        </div>
        <label>Notes (optional)<textarea value={form.notes} onChange={set("notes")} rows={3} /></label>
        {error && <p className="mgrError" role="alert">{error}</p>}
        <div className="osActions"><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : account ? "Save changes" : "Open account"}</button></div>
      </form>
    </main>
  );
}

function AccountDetail({ id, printers, onBack, onEdit }: { id: string; printers: Printer[]; onBack: () => void; onEdit: (account: HouseAccount) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [panel, setPanel] = useState<"" | "payment" | "adjustment" | "statement">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setDetail(await call<Detail>(`/api/employee/house-accounts/${id}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the account."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await call(`/api/employee/house-accounts/${id}`, body); setNotice(done); setPanel(""); await load(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't save."); return false; }
    finally { setBusy(false); }
  };
  if (!detail) return <main className="mgrPage"><header className="mgrHeader"><button type="button" onClick={onBack}>‹ Accounts</button></header>{error ? <p className="mgrError">{error}</p> : <p className="mgrEmpty">Loading…</p>}</main>;
  const { account } = detail;
  const available = account.creditLimitCents != null ? account.creditLimitCents - account.balanceCents : null;
  const setStatus = (status: string, label: string) => {
    if (status === "closed" && account.balanceCents !== 0 && !window.confirm(`${account.name} still has a balance of ${money(account.balanceCents)}. Close the account anyway? It can't be charged once closed.`)) return;
    void act({ action: "status", status }, label);
  };
  return (
    <main className="mgrPage">
      <header className="mgrHeader">
        <button type="button" onClick={onBack}>‹ Accounts</button>
        <h1>{account.name}</h1>
        <nav className="haLinks"><button type="button" onClick={() => onEdit(account)}>Edit</button></nav>
      </header>
      <section className="mgrTiles osSummary">
        <article className={account.balanceCents > 0 ? "warn" : ""}><span>Balance owed</span><strong>{money(account.balanceCents)}</strong><small>{account.lastChargeAt ? `last charge ${day(account.lastChargeAt)}` : "no charges yet"}</small></article>
        <article><span>Credit limit</span><strong>{account.creditLimitCents != null ? money(account.creditLimitCents) : "None"}</strong><small>{available != null ? `${money(Math.max(0, available))} available` : "any amount can be charged"}</small></article>
        <article><span>Last payment</span><strong>{account.lastPaymentAt ? day(account.lastPaymentAt) : "Never"}</strong><small>{[account.phone, account.email].filter(Boolean).join(" · ") || "no contact details"}</small></article>
        <article className={account.status !== "active" ? "warn" : ""}><span>Status</span><strong>{statusLabels[account.status]}</strong><small>{account.status === "active" ? "can be charged at the POS" : "can't be charged"}</small></article>
      </section>
      {account.notes && <p className="mgrEmpty">{account.notes}</p>}
      <div className="haActions">
        <button type="button" className={panel === "payment" ? "primary" : ""} onClick={() => setPanel(panel === "payment" ? "" : "payment")}>Record payment</button>
        <button type="button" className={panel === "statement" ? "primary" : ""} onClick={() => setPanel(panel === "statement" ? "" : "statement")}>Statement</button>
        <button type="button" className={panel === "adjustment" ? "primary" : ""} onClick={() => setPanel(panel === "adjustment" ? "" : "adjustment")}>Credit / adjustment</button>
        {account.status === "active" && <button type="button" disabled={busy} onClick={() => setStatus("hold", "Account put on hold.")}>Put on hold</button>}
        {account.status !== "active" && <button type="button" disabled={busy} onClick={() => setStatus("active", "Account is active again.")}>{account.status === "closed" ? "Reopen" : "Take off hold"}</button>}
        {account.status !== "closed" && <button type="button" disabled={busy} onClick={() => setStatus("closed", "Account closed.")}>Close account</button>}
      </div>
      {notice && <p className="haNotice" role="status">{notice}</p>}
      {error && <p className="mgrError" role="alert">{error}</p>}
      {panel === "payment" && <PaymentPanel busy={busy} balanceCents={account.balanceCents} onSubmit={(body) => act({ action: "payment", ...body }, "Payment recorded.")} />}
      {panel === "adjustment" && <AdjustmentPanel busy={busy} onSubmit={(body) => act({ action: "adjustment", ...body }, "Adjustment recorded.")} />}
      {panel === "statement" && <StatementPanel id={id} printers={printers} busy={busy} onPrint={(body) => act({ action: "print_statement", ...body }, "Statement sent to the receipt printer.")} />}
      <section className="mgrSection">
        <h2>Activity<span>{detail.activity.length}{detail.truncated ? "+" : ""}</span></h2>
        {detail.activity.length === 0 && <p className="mgrEmpty">Nothing on this tab yet. Charge an order to it at the POS: Checkout → HOUSE ACCOUNT.</p>}
        {detail.activity.map((entry) => <div key={entry.id} className="mgrRow">
          <div>
            <strong>{kindLabels[entry.type] || entry.type}{entry.orderNumber ? <> · <a className="osLink" href={`/employee/manager/orders?days=90&number=${encodeURIComponent(entry.orderNumber)}`}>#{entry.orderNumber}</a></> : ""}{entry.method ? ` · ${entry.method}` : ""}{entry.reference && !entry.orderNumber ? ` #${entry.reference}` : ""}</strong>
            <small>{when(entry.at)} · {entry.by || "Unknown"}{entry.device ? ` · ${entry.device}` : ""}</small>
            {entry.items && <small>{entry.items}</small>}
            {entry.description && entry.type !== "charge" && <small>{entry.description}</small>}
          </div>
          <div className="haAmount"><b className={entry.deltaCents > 0 ? "haOwes" : "good"}>{signed(entry.deltaCents)}</b><small>bal {money(entry.balanceCents)}</small></div>
        </div>)}
      </section>
    </main>
  );
}

function PaymentPanel({ busy, balanceCents, onSubmit }: { busy: boolean; balanceCents: number; onSubmit: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [form, setForm] = useState({ amount: balanceCents > 0 ? (balanceCents / 100).toFixed(2) : "", method: "cash", reference: "", note: "" });
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return <form className="osForm" onSubmit={(event) => { event.preventDefault(); const amount = cents(form.amount); if (!amount) { setError("Enter the amount paid."); return; } setError(""); void onSubmit({ amountCents: amount, method: form.method, reference: form.reference, note: form.note }); }}>
    <strong>Payment received</strong>
    <div className="osFields">
      <label>Amount<input value={form.amount} onChange={set("amount")} inputMode="decimal" autoComplete="off" required /></label>
      <label>Paid by<select value={form.method} onChange={set("method")}><option value="cash">Cash</option><option value="check">Check</option><option value="card">Card</option></select></label>
      <label>{form.method === "check" ? "Check number" : "Reference (optional)"}<input value={form.reference} onChange={set("reference")} autoComplete="off" required={form.method === "check"} /></label>
      <label>Note (optional)<input value={form.note} onChange={set("note")} autoComplete="off" /></label>
    </div>
    {form.method === "card" && <small className="haHint">Run the card on the store terminal first; this only records it on the tab.</small>}
    {error && <p className="mgrError">{error}</p>}
    <div className="osActions"><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Record payment"}</button></div>
  </form>;
}

function AdjustmentPanel({ busy, onSubmit }: { busy: boolean; onSubmit: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [form, setForm] = useState({ amount: "", direction: "credit", reason: "" });
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return <form className="osForm" onSubmit={(event) => { event.preventDefault(); const amount = cents(form.amount); if (!amount) { setError("Enter the amount."); return; } if (form.reason.trim().length < 3) { setError("Enter the reason."); return; } setError(""); void onSubmit({ amountCents: amount, direction: form.direction, reason: form.reason }); }}>
    <strong>Credit or adjustment</strong>
    <div className="osFields">
      <label>Type<select value={form.direction} onChange={set("direction")}><option value="credit">Credit (takes off the balance)</option><option value="debit">Debit (adds to the balance)</option></select></label>
      <label>Amount<input value={form.amount} onChange={set("amount")} inputMode="decimal" autoComplete="off" required /></label>
      <label>Reason<input value={form.reason} onChange={set("reason")} autoComplete="off" required placeholder="e.g. wrong sandwich, comped" /></label>
    </div>
    {error && <p className="mgrError">{error}</p>}
    <div className="osActions"><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Record adjustment"}</button></div>
  </form>;
}

function StatementPanel({ id, printers, busy, onPrint }: { id: string; printers: Printer[]; busy: boolean; onPrint: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const [printerId, setPrinterId] = useState(printers[0]?.id || "");
  const [summary, setSummary] = useState<{ from: string; to: string; today: string; totals: { openingCents: number; chargesCents: number; paymentsAndCreditsCents: number; closingCents: number }; rows: unknown[] } | null>(null);
  // The server picks the default dates (since the last payment, or this month).
  useEffect(() => {
    const params = new URLSearchParams({ statement: "1", ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) });
    call<NonNullable<typeof summary>>(`/api/employee/house-accounts/${id}?${params}`).then((body) => { setSummary(body); setRange((current) => current.from && current.to ? current : { from: body.from, to: body.to }); }).catch(() => setSummary(null));
  }, [id, range.from, range.to]);
  const query = new URLSearchParams({ from: range.from, to: range.to });
  return <div className="osForm">
    <strong>Statement</strong>
    <div className="osDates">
      <label>From<input type="date" value={range.from} max={summary?.today} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} /></label>
      <label>To<input type="date" value={range.to} max={summary?.today} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} /></label>
    </div>
    {summary && <small className="haHint">Previous balance {money(summary.totals.openingCents)} · charges {money(summary.totals.chargesCents)} · payments &amp; credits {money(summary.totals.paymentsAndCreditsCents)} · <b>balance due {money(summary.totals.closingCents)}</b> ({summary.rows.length} entries)</small>}
    <div className="osActions haWrap">
      <a className="haButton primary" href={`/employee/manager/house-accounts/${id}/statement?${query}`} target="_blank" rel="noreferrer">Full-page statement / PDF</a>
      {printers.length > 0 ? <>
        <select value={printerId} onChange={(event) => setPrinterId(event.target.value)} aria-label="Receipt printer">{printers.map((printer) => <option key={printer.id} value={printer.id}>{printer.name}</option>)}</select>
        <button type="button" disabled={busy || !printerId} onClick={() => void onPrint({ from: range.from, to: range.to, printerId })}>{busy ? "Printing…" : "Print on receipt printer"}</button>
      </> : <small className="haHint">No receipt printer is set up, so the statement can only be printed full-page.</small>}
    </div>
  </div>;
}

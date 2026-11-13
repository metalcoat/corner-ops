"use client";
import { useCallback, useEffect, useState } from "react";
import type { HouseAccount, houseAccountDetail } from "@/lib/ordering-house-accounts";
import "./house-accounts.css";

// POS Tabs: any employee can look up a house account to tell the customer their total,
// see every charge and payment, and print the statement. Changes stay with managers.
type Detail = NonNullable<Awaited<ReturnType<typeof houseAccountDetail>>> & { printers: Array<{ id: string; name: string }> };
type Summary = { from: string; to: string; today: string; totals: { openingCents: number; chargesCents: number; paymentsAndCreditsCents: number; closingCents: number } };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money(Math.abs(cents))}`;
const when = (iso: string | null) => iso ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "";
const kinds: Record<string, string> = { charge: "Charge", payment: "Payment", credit: "Credit", refund: "Refund", reversal: "Charge reversed", adjustment: "Adjustment" };

async function call<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload as T;
}

export default function HouseAccountLookup() {
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<HouseAccount[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (selected) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      call<{ accounts: HouseAccount[] }>(`/api/ordering/house-accounts?q=${encodeURIComponent(query.trim())}`)
        .then((body) => { if (!controller.signal.aborted) { setAccounts(body.accounts); setError(""); } })
        .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "House accounts could not be loaded."); });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, selected]);
  // ?account=<id> opens that account (the statement page links back here).
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("account"); if (id) setSelected(id); }, []);
  const open = (id: string | null) => { setSelected(id); window.history.replaceState(null, "", id ? `?account=${id}` : window.location.pathname); };

  if (selected) return <AccountView id={selected} onBack={() => open(null)} />;
  return (
    <main className="posTabs">
      <header><h1>House accounts</h1><p>Look up a customer&apos;s tab to give them their total. To charge an order, use HOUSE ACCOUNT at checkout.</p></header>
      <input className="posTabsSearch" type="search" placeholder="Search name or phone" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search house accounts" autoComplete="off" autoFocus />
      {error && <p className="posTabsError" role="alert">{error}</p>}
      {accounts?.length === 0 && <p className="posTabsEmpty">{query ? "No account matches." : "No house accounts yet. A manager adds them in the Employee Hub → House accounts."}</p>}
      <div className="posTabsList">
        {accounts?.map((account) => <button type="button" key={account.id} onClick={() => open(account.id)}>
          <span><strong>{account.name}</strong><small>{account.phone || "No phone"}{account.status === "hold" ? " · ON HOLD" : ""}</small></span>
          <b className={account.balanceCents > 0 ? "owes" : ""}>{money(account.balanceCents)}</b>
        </button>)}
      </div>
    </main>
  );
}

function AccountView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [range, setRange] = useState({ from: "", to: "" });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [printerId, setPrinterId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const body = await call<Detail>(`/api/ordering/house-accounts/${id}`);
      setDetail(body);
      // The receipt printer this POS already uses, else the first one.
      let stored = "";
      try { stored = localStorage.getItem("corner-ops-receipt-printer") || ""; } catch {}
      setPrinterId((current) => current || (body.printers.some((printer) => printer.id === stored) ? stored : body.printers[0]?.id || ""));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the account."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // The server picks the default dates (since the last payment, or this month).
  useEffect(() => {
    const params = new URLSearchParams({ statement: "1", ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) });
    call<Summary>(`/api/ordering/house-accounts/${id}?${params}`).then((body) => { setSummary(body); setRange((current) => current.from && current.to ? current : { from: body.from, to: body.to }); }).catch(() => setSummary(null));
  }, [id, range.from, range.to]);
  const print = async () => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await call<{ printer: string }>(`/api/ordering/house-accounts/${id}`, { action: "print_statement", from: range.from, to: range.to, printerId }); setNotice(`Statement printed on ${result.printer}.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The statement didn't print."); }
    finally { setBusy(false); }
  };
  if (!detail) return <main className="posTabs"><button type="button" className="posTabsBack" onClick={onBack}>‹ ALL ACCOUNTS</button>{error ? <p className="posTabsError">{error}</p> : <p className="posTabsEmpty">Loading…</p>}</main>;
  const { account } = detail;
  const available = account.creditLimitCents != null ? Math.max(0, account.creditLimitCents - account.balanceCents) : null;
  return (
    <main className="posTabs">
      <button type="button" className="posTabsBack" onClick={onBack}>‹ ALL ACCOUNTS</button>
      <section className="posTabsTotal">
        <div><h1>{account.name}</h1><p>{[account.phone, account.status === "active" ? "" : account.status === "hold" ? "ON HOLD: can't be charged" : "CLOSED"].filter(Boolean).join(" · ")}</p></div>
        <div className="amount"><small>OWES</small><strong className={account.balanceCents > 0 ? "owes" : ""}>{money(account.balanceCents)}</strong>{available != null && <small>{money(available)} left of {money(account.creditLimitCents || 0)} limit</small>}</div>
      </section>
      {account.notes && <p className="posTabsEmpty">{account.notes}</p>}
      <section className="posTabsStatement" aria-label="Statement">
        <h2>Statement</h2>
        <div className="dates">
          <label>From<input type="date" value={range.from} max={summary?.today} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} /></label>
          <label>To<input type="date" value={range.to} max={summary?.today} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} /></label>
        </div>
        {summary && <p>Previous balance {money(summary.totals.openingCents)} · charges {money(summary.totals.chargesCents)} · payments &amp; credits {money(summary.totals.paymentsAndCreditsCents)} · <b>balance due {money(summary.totals.closingCents)}</b></p>}
        <div className="actions">
          {detail.printers.length > 0 && <>
            <select value={printerId} onChange={(event) => setPrinterId(event.target.value)} aria-label="Receipt printer">{detail.printers.map((printer) => <option key={printer.id} value={printer.id}>{printer.name}</option>)}</select>
            <button type="button" className="primary" disabled={busy || !printerId} onClick={() => void print()}>{busy ? "PRINTING…" : "PRINT RECEIPT"}</button>
          </>}
          <a href={`/pos/house-accounts/${id}/statement?${new URLSearchParams({ from: range.from, to: range.to })}`} target="_blank" rel="noreferrer">FULL PAGE / PDF</a>
        </div>
        {notice && <p className="posTabsNotice" role="status">{notice}</p>}
        {error && <p className="posTabsError" role="alert">{error}</p>}
      </section>
      <section className="posTabsActivity">
        <h2>Every charge and payment</h2>
        {detail.activity.length === 0 && <p className="posTabsEmpty">Nothing on this tab yet.</p>}
        {detail.activity.map((entry) => <div key={entry.id} className="row">
          <div><strong>{kinds[entry.type] || entry.type}{entry.orderNumber ? ` · #${entry.orderNumber}` : ""}{entry.method ? ` · ${entry.method}` : ""}</strong><small>{when(entry.at)} · {entry.by || "Unknown"}</small>{entry.items && <small>{entry.items}</small>}{entry.description && entry.type !== "charge" && <small>{entry.description}</small>}</div>
          <div className="amount"><b className={entry.deltaCents > 0 ? "owes" : "paid"}>{signed(entry.deltaCents)}</b><small>bal {money(entry.balanceCents)}</small></div>
        </div>)}
      </section>
    </main>
  );
}

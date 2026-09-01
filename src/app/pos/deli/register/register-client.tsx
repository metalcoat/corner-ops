"use client";

import { useCallback, useEffect, useState } from "react";
import "./register.css";

const money = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
type Dashboard = { station: { name: string; sharedRegisterKey: string }; terminal: { name: string }; session: any; movements: any[]; recent: any[]; canManage: boolean };

export default function RegisterClient() {
  const [data, setData] = useState<Dashboard | null>(null), [message, setMessage] = useState(""), [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [stationKey, setStationKey] = useState("");
  const load = useCallback(async () => {
    if (!stationKey) return;
    const response = await fetch(`/api/ordering/register?stationKey=${encodeURIComponent(stationKey)}`, { cache: "no-store" }), body = await response.json();
    if (!response.ok) throw new Error(body.error || "Register unavailable.");
    localStorage.setItem(`corner-ops-register-${stationKey}`, JSON.stringify({ open: body.session?.status === "open", checkedAt: Date.now(), sessionId: body.session?.id || null }));
    setData(body);
  }, [stationKey]);
  useEffect(() => { const key = localStorage.getItem("corner-ops-station-key") || ""; setStationKey(key); if (!key) setMessage("Assign this device to a POS station in Settings → Hardware first."); }, []);
  useEffect(() => { if (stationKey) void load().catch(error => setMessage(error.message)); }, [load, stationKey]);
  async function action(name: string) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/ordering/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stationKey, action: name, amountCents: Math.round(Number(amount || 0) * 100), reason, notes: reason }) }), body = await response.json();
      if (!response.ok) throw new Error(body.error || "Register update failed.");
      setAmount(""); setReason(""); await load();
      setMessage(name === "no_sale" ? "Drawer opened and recorded as No Sale." : name === "close" && body.status === "needs_review" ? "Count saved. A manager must review the drawer variance." : "Register updated.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Register update failed."); } finally { setBusy(false); }
  }
  if (!data) return <main className="registerPage"><h1>Register</h1><p role="alert">{message || "Loading register…"}</p></main>;
  const session = data.session;
  return <main className="registerPage">
    <header><div><span>{data.station.name}</span><h1>{data.terminal.name}</h1></div><button onClick={() => void load()}>REFRESH</button></header>
    {message && <p className="registerMessage" role="status">{message}</p>}
    {!session ? <section className="registerOpen"><h2>Open register</h2><p>Count the starting cash before taking the first cash payment.</p><label>Opening cash<input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label><button disabled={busy} onClick={() => void action("open")}>OPEN REGISTER</button></section> : <>
      <section className="registerSummary"><article><span>Status</span><strong>{String(session.status).replaceAll("_", " ").toUpperCase()}</strong></article><article><span>Opening cash</span><strong>{money(Number(session.opening_cash_cents))}</strong></article>{session.status !== "counting" && <article><span>Expected cash</span><strong>{money(Number(session.expected_cash_cents))}</strong></article>}{session.counted_cash_cents != null && <article><span>Counted</span><strong>{money(Number(session.counted_cash_cents))}</strong></article>}{session.over_short_cents != null && <article><span>Over / short</span><strong className={Number(session.over_short_cents) === 0 ? "ok" : "variance"}>{money(Number(session.over_short_cents))}</strong></article>}</section>
      {session.status === "open" && <section className="registerActions"><h2>Drawer actions</h2>{data.canManage && <><button className="noSale" disabled={busy} onClick={() => void action("no_sale")}>NO SALE / OPEN DRAWER</button><label>Amount<input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label><label>Reason<input value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label><div><button disabled={busy} onClick={() => void action("paid_in")}>PAID IN</button><button disabled={busy} onClick={() => void action("paid_out")}>PAID OUT</button><button disabled={busy} onClick={() => void action("drop")}>CASH DROP</button></div></>}<button className="primary" disabled={busy} onClick={() => void action("start_count")}>START BLIND CLOSE COUNT</button></section>}
      {session.status === "counting" && <section className="registerOpen"><h2>Blind drawer count</h2><p>Enter the physical cash count. The expected amount remains hidden until the count is submitted.</p><label>Counted cash<input autoFocus type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label><label>Closing note<input value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={busy} onClick={() => void action("close")}>SUBMIT COUNT</button></section>}
      {session.status === "needs_review" && <section className="registerOpen"><h2>Manager review required</h2><p>Expected {money(Number(session.expected_cash_cents))} · counted {money(Number(session.counted_cash_cents))} · variance {money(Number(session.over_short_cents))}</p>{data.canManage ? <><label>Review reason<input value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={busy || reason.trim().length < 3} onClick={() => void action("approve_variance")}>APPROVE & CLOSE</button></> : <p>A manager must sign in to close this register.</p>}</section>}
      <section><h2>Movement history</h2><div className="registerMovements">{data.movements.map(row => <article key={row.id}><strong>{String(row.movement_type).replaceAll("_", " ")}</strong><span>{row.reason}</span><b>{Number(row.delta_cash_cents) > 0 ? "+" : ""}{money(Number(row.delta_cash_cents))}</b></article>)}</div></section>
    </>}
  </main>;
}

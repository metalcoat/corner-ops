"use client";
// Employee stock sheet: count what's on the shelf and ask for what we need.
// Signs in with the employee PIN, like the driver tablet, so it works on a
// phone in the walk-in as well as the kitchen tablet.
import { useCallback, useEffect, useMemo, useState } from "react";

type Item = { id: string; name: string; category: string; unit: string; casePack: number | null; onHand: number; par: number | null; lastCountedAt: string | null };
type Request = { id: string; item_name: string | null; item_text: string; quantity: number | null; unit: string; urgency: "low" | "out"; note: string; status: string; requested_by_name: string; requested_at: string };
type Sheet = { employee: string; items: Item[]; requests: Request[] };

const qty = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-US");
const ago = (iso: string | null) => {
  if (!iso) return "never counted";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "counted today" : days === 1 ? "counted yesterday" : `counted ${days} days ago`;
};
async function message(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error || `Request failed (${response.status}).`;
}

export default function StockSheet() {
  const [data, setData] = useState<Sheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [pin, setPin] = useState("");
  const [tab, setTab] = useState<"have" | "need">("have");
  const [search, setSearch] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [asking, setAsking] = useState<{ itemId: string; itemText: string; quantity: string; urgency: "low" | "out"; note: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/employee/stock", { cache: "no-store" });
      if (response.status === 401) return setData(null);
      if (!response.ok) throw new Error(await message(response));
      setData(await response.json());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Stock list could not load.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy("login");
    setError("");
    const response = await fetch("/api/employee/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ business: "Corner Deli", pin, deviceLabel: "Stock sheet" }),
    });
    setPin("");
    setBusy("");
    if (!response.ok) return setError(await message(response));
    await load();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? []).filter((item) => !q || item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q));
  }, [data?.items, search]);
  const groups = useMemo(() => Map.groupBy(filtered, (item) => item.category), [filtered]);
  const entered = Object.entries(counts).filter(([, value]) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);

  function bump(item: Item, by: number) {
    setCounts((current) => {
      const now = current[item.id] === undefined || current[item.id] === "" ? 0 : Number(current[item.id]) || 0;
      return { ...current, [item.id]: String(Math.max(0, Math.round((now + by) * 100) / 100)) };
    });
  }

  async function saveCounts() {
    setBusy("count");
    setError("");
    try {
      const response = await fetch("/api/employee/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "count", counts: entered.map(([itemId, value]) => ({ itemId, quantity: Number(value) })) }),
      });
      if (!response.ok) throw new Error(await message(response));
      const result = await response.json();
      setCounts({});
      setNotice(`Saved ${result.counted} count${result.counted === 1 ? "" : "s"}. Thanks!`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Counts didn't save. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function sendRequest() {
    if (!asking) return;
    setBusy("request");
    setError("");
    try {
      const item = data?.items.find((i) => i.id === asking.itemId);
      const response = await fetch("/api/employee/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request", itemId: asking.itemId || undefined, itemText: asking.itemText, quantity: asking.quantity ? Number(asking.quantity) : null, unit: item?.unit ?? "", urgency: asking.urgency, note: asking.note }),
      });
      if (!response.ok) throw new Error(await message(response));
      setAsking(null);
      setSearch("");
      setNotice("Added to the order list. A manager will see it.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That didn't save.");
    } finally {
      setBusy("");
    }
  }

  if (loading) return <main className="stockApp"><p className="stockEmpty">Loading…</p></main>;
  if (!data)
    return (
      <main className="stockApp">
        <form className="stockLogin" onSubmit={login}>
          <p className="eyebrow">CORNER DELI</p>
          <h1>Stock sheet</h1>
          <p>Count what we have and tell the manager what we need.</p>
          <label>
            Employee PIN
            <input inputMode="numeric" type="password" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          </label>
          <button disabled={pin.length !== 4 || busy === "login"}>{busy ? "SIGNING IN…" : "SIGN IN"}</button>
          {error && <p className="stockError" role="alert">{error}</p>}
        </form>
      </main>
    );

  const open = data.requests.filter((r) => r.status === "open");
  return (
    <main className="stockApp">
      <header className="stockTop">
        <div>
          <p className="eyebrow">STOCK SHEET</p>
          <h1>{data.employee}</h1>
        </div>
        <nav className="stockTabs" role="tablist">
          <button role="tab" aria-selected={tab === "have"} onClick={() => setTab("have")}>WHAT WE HAVE</button>
          <button role="tab" aria-selected={tab === "need"} onClick={() => setTab("need")}>WHAT WE NEED {open.length > 0 && <b>{open.length}</b>}</button>
        </nav>
      </header>
      {error && <p className="stockError" role="alert">{error} <button onClick={() => setError("")}>OK</button></p>}
      {notice && <p className="stockNotice" role="status">{notice}</p>}
      <input className="stockSearch" placeholder={tab === "have" ? "Find an item to count…" : "What do we need? Search or type it…"} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search items" />

      {tab === "have" ? (
        <>
          {data.items.length === 0 && <p className="stockEmpty">No stock items yet. A manager adds them under Supplier costs or Inventory.</p>}
          {[...groups.entries()].map(([category, items]) => (
            <section key={category} className="stockGroup">
              <h2>{category}</h2>
              <ul>
                {items.map((item) => {
                  const value = counts[item.id] ?? "";
                  const low = item.par != null && item.onHand < item.par * 0.5;
                  return (
                    <li key={item.id} className={value !== "" ? "touched" : ""}>
                      <div className="stockName">
                        <b>{item.name}</b>
                        <small>
                          System says {qty(item.onHand)} {item.unit}
                          {item.par != null && <> · keep {qty(item.par)}</>} · {ago(item.lastCountedAt)}
                          {low && <em> · running low</em>}
                        </small>
                      </div>
                      <div className="stockCounter">
                        <button aria-label={`One less ${item.name}`} onClick={() => bump(item, -1)}>−</button>
                        <label>
                          <input inputMode="decimal" placeholder="count" value={value} onChange={(e) => setCounts((c) => ({ ...c, [item.id]: e.target.value.replace(/[^\d.]/g, "") }))} aria-label={`${item.name} on hand in ${item.unit}`} />
                          <span>{item.unit}</span>
                        </label>
                        <button aria-label={`One more ${item.name}`} onClick={() => bump(item, 1)}>+</button>
                        {item.casePack && item.casePack > 1 ? <button className="caseButton" onClick={() => bump(item, item.casePack!)}>+ CASE ({qty(item.casePack)})</button> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <footer className="stockDock">
            <span>{entered.length ? `${entered.length} item${entered.length === 1 ? "" : "s"} counted` : "Type what's on the shelf. Leave blank to skip."}</span>
            <button disabled={!entered.length || busy === "count"} onClick={() => void saveCounts()}>{busy === "count" ? "SAVING…" : "SAVE COUNTS"}</button>
          </footer>
        </>
      ) : (
        <>
          {asking ? (
            <section className="askCard">
              <h2>{data.items.find((i) => i.id === asking.itemId)?.name || asking.itemText}</h2>
              <div className="urgency" role="radiogroup" aria-label="How urgent">
                <button role="radio" aria-checked={asking.urgency === "low"} onClick={() => setAsking({ ...asking, urgency: "low" })}>RUNNING LOW</button>
                <button role="radio" aria-checked={asking.urgency === "out"} className="out" onClick={() => setAsking({ ...asking, urgency: "out" })}>WE&apos;RE OUT</button>
              </div>
              <label>
                How much do we need? (optional)
                <span className="askQty">
                  <input inputMode="decimal" value={asking.quantity} onChange={(e) => setAsking({ ...asking, quantity: e.target.value.replace(/[^\d.]/g, "") })} />
                  <span>{data.items.find((i) => i.id === asking.itemId)?.unit ?? ""}</span>
                </span>
              </label>
              <label>
                Note (optional)
                <input value={asking.note} maxLength={300} onChange={(e) => setAsking({ ...asking, note: e.target.value })} placeholder="e.g. need it for Saturday's catering" />
              </label>
              <div className="askActions">
                <button className="ghost" onClick={() => setAsking(null)}>CANCEL</button>
                <button disabled={busy === "request"} onClick={() => void sendRequest()}>{busy === "request" ? "SENDING…" : "ADD TO ORDER LIST"}</button>
              </div>
            </section>
          ) : (
            search.trim() && (
              <ul className="pickList">
                {filtered.slice(0, 12).map((item) => (
                  <li key={item.id}>
                    <button onClick={() => setAsking({ itemId: item.id, itemText: "", quantity: "", urgency: "low", note: "" })}>
                      <b>{item.name}</b>
                      <small>{qty(item.onHand)} {item.unit} on hand</small>
                    </button>
                  </li>
                ))}
                <li>
                  <button className="other" onClick={() => setAsking({ itemId: "", itemText: search.trim(), quantity: "", urgency: "low", note: "" })}>
                    <b>+ “{search.trim()}”</b>
                    <small>Something not on the list</small>
                  </button>
                </li>
              </ul>
            )
          )}
          <section className="requestList">
            <h2>On the order list</h2>
            {data.requests.length === 0 && <p className="stockEmpty">Nothing yet. Search above to add something.</p>}
            <ul>
              {data.requests.map((r) => (
                <li key={r.id} className={`${r.status} ${r.urgency}`}>
                  <span className="tag">{r.status === "open" ? (r.urgency === "out" ? "OUT" : "LOW") : r.status === "ordered" ? "ORDERED" : "SKIPPED"}</span>
                  <div>
                    <b>{r.item_name || r.item_text}{r.quantity ? ` · ${qty(r.quantity)} ${r.unit}` : ""}</b>
                    <small>{r.requested_by_name} · {new Date(r.requested_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })}{r.note ? ` · ${r.note}` : ""}</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

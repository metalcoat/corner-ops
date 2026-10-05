"use client";
// Label station: the sub and pizza makers tap an item to print its sticker
// label; it disappears from the list. Printed labels stay in the side tray
// for a quick reprint if one got stuck on the wrong box.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Unit = {
  orderId: string;
  orderItemId: string;
  unitIndex: number;
  code: string;
  count: string;
  customer: string;
  item: string;
  options: string[];
  note: string;
  destination: string;
  footer: string;
  printed: boolean;
  printCount: number;
  lastPrintedAt: string | null;
};
type OrderGroup = { orderId: string; code: string; customer: string; destination: string; footer: string; units: Unit[] };
type Printer = { id: string; name: string; status: string };
type Queue = { printers: Printer[]; printer: Printer | null; orders: OrderGroup[]; recent: Unit[] };

const PRINTER_KEY = "corner-ops-label-printer";
const unitKey = (unit: Pick<Unit, "orderItemId" | "unitIndex">) => `${unit.orderItemId}:${unit.unitIndex}`;
const clock = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function LabelStationClient() {
  const [printerId, setPrinterId] = useState<string | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [signedOut, setSignedOut] = useState(false);
  const loading = useRef(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("printer");
    let saved = "";
    try {
      saved = localStorage.getItem(PRINTER_KEY) || "";
      if (fromUrl) localStorage.setItem(PRINTER_KEY, fromUrl);
    } catch {}
    setPrinterId(fromUrl || saved);
  }, []);

  const load = useCallback(async () => {
    if (printerId === null || loading.current) return;
    loading.current = true;
    try {
      const response = await fetch(`/api/ordering/labels?${new URLSearchParams({ business: "Corner Deli", printerId })}`, { cache: "no-store" });
      if (response.status === 401) {
        setSignedOut(true);
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Labels could not be loaded.");
      setSignedOut(false);
      setQueue(body);
      setHidden(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Labels could not be loaded.");
    } finally {
      loading.current = false;
    }
  }, [printerId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => document.visibilityState === "visible" && void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function choosePrinter(id: string) {
    try {
      localStorage.setItem(PRINTER_KEY, id);
    } catch {}
    setQueue(null);
    setPrinterId(id);
  }

  async function print(units: Unit[], reprint = false) {
    if (!queue?.printer) return;
    setError("");
    const keys = units.map(unitKey);
    setBusy((current) => new Set([...current, ...keys]));
    let printed = 0;
    try {
      for (const unit of units) {
        const response = await fetch("/api/ordering/labels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ business: "Corner Deli", printerId: queue.printer.id, orderItemId: unit.orderItemId, unitIndex: unit.unitIndex, reprint }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "The label did not print.");
        printed++;
        if (!reprint) setHidden((current) => new Set([...current, unitKey(unit)]));
      }
      setNotice(reprint ? `Reprinted ${units[0].code}` : printed === 1 ? `Printed ${units[0].code}` : `Printed ${printed} labels`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The label did not print.");
    } finally {
      setBusy((current) => new Set([...current].filter((key) => !keys.includes(key))));
      void load();
    }
  }

  if (signedOut)
    return (
      <main className="labelStation">
        <section className="labelEmpty">
          <h1>Sign in to the POS first</h1>
          <p>The label station uses the POS sign-in. Sign in with your PIN, then come back to this screen.</p>
          <Link className="labelButton" href="/pos/deli">Go to POS sign-in</Link>
        </section>
      </main>
    );
  if (!queue)
    return (
      <main className="labelStation">
        <p className="labelLoading">Loading labels…</p>
      </main>
    );

  if (!queue.printer)
    return (
      <main className="labelStation">
        <section className="labelEmpty">
          <h1>Which label printer is at this station?</h1>
          {queue.printers.length ? (
            <div className="labelPrinterChoices">
              {queue.printers.map((printer) => (
                <button key={printer.id} onClick={() => choosePrinter(printer.id)}>
                  <span className={`labelDot ${printer.status}`} />
                  {printer.name}
                </button>
              ))}
            </div>
          ) : (
            <p>
              No label printer is set up yet. A manager can add one under{" "}
              <Link href="/pos/deli/settings/hardware">Settings → Printers &amp; devices</Link> (choose “Food labels”).
            </p>
          )}
        </section>
      </main>
    );

  const orders = queue.orders
    .map((order) => ({ ...order, units: order.units.filter((unit) => !unit.printed && !hidden.has(unitKey(unit))) }))
    .filter((order) => order.units.length);
  const waiting = orders.reduce((sum, order) => sum + order.units.length, 0);

  return (
    <main className="labelStation">
      <header className="labelHeader">
        <div>
          <p>LABEL STATION</p>
          <h1>
            {waiting} label{waiting === 1 ? "" : "s"} to print
          </h1>
        </div>
        <button className="labelPrinterName" onClick={() => choosePrinter("")} title="Change printer">
          <span className={`labelDot ${queue.printer.status}`} />
          {queue.printer.name}
          <small>change</small>
        </button>
      </header>
      {error && (
        <p className="labelError" role="alert">
          {error}
          <button onClick={() => setError("")}>OK</button>
        </p>
      )}
      {notice && <p className="labelNotice" role="status">{notice}</p>}
      <div className="labelLayout">
        <section className="labelOrders" aria-label="Labels to print">
          {orders.length === 0 ? (
            <div className="labelAllDone">
              <strong>All caught up</strong>
              <span>New subs and pizzas show up here as orders come in.</span>
            </div>
          ) : (
            orders.map((order) => (
              <article className="labelOrder" key={order.orderId}>
                <header>
                  <div>
                    <strong>{order.code}</strong> {order.customer}
                    <small>
                      {order.destination} · {order.footer}
                    </small>
                  </div>
                  {order.units.length > 1 && (
                    <button disabled={order.units.some((unit) => busy.has(unitKey(unit)))} onClick={() => void print(order.units)}>
                      PRINT ALL {order.units.length}
                    </button>
                  )}
                </header>
                <div className="labelUnits">
                  {order.units.map((unit) => {
                    const printing = busy.has(unitKey(unit));
                    return (
                      <button key={unitKey(unit)} className="labelUnit" disabled={printing} onClick={() => void print([unit])}>
                        <span className="labelCode">{unit.code.split("-").pop()}</span>
                        <span className="labelItem">
                          <b>{unit.item}</b>
                          {unit.options.length > 0 && <small>{unit.options.join(", ")}</small>}
                          {unit.note && <em>{unit.note}</em>}
                        </span>
                        <span className="labelAction">{printing ? "PRINTING…" : unit.count ? `PRINT ${unit.count}` : "PRINT"}</span>
                      </button>
                    );
                  })}
                </div>
              </article>
            ))
          )}
        </section>
        <aside className="labelRecent" aria-label="Recently printed">
          <h2>Printed — tap to reprint</h2>
          {queue.recent.length === 0 ? (
            <p>Nothing printed yet.</p>
          ) : (
            <ul>
              {queue.recent.map((unit) => (
                <li key={unitKey(unit)}>
                  <span>
                    <b>{unit.code}</b> {unit.item}
                    <small>
                      {unit.customer}
                      {unit.lastPrintedAt ? ` · ${clock(unit.lastPrintedAt)}` : ""}
                      {unit.printCount > 1 ? ` · printed ${unit.printCount}×` : ""}
                    </small>
                  </span>
                  <button disabled={busy.has(unitKey(unit))} onClick={() => void print([unit], true)}>
                    {busy.has(unitKey(unit)) ? "…" : "REPRINT"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </main>
  );
}

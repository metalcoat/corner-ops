"use client";
import { useEffect, useState } from "react";
const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
type Order = {
  order_id: string;
  display_number: string;
  amount_due_cents: number;
  driver_employee_id: string;
  customer_name: string;
  delivery_address: string;
  delivery_unit: string;
  delivered_at: string;
  delivery_status: string | null;
};
export default function DriverCashClient() {
  const [data, setData] = useState<any>(null),
    [selected, setSelected] = useState<string[]>([]),
    [turnedIn, setTurnedIn] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch("/api/ordering/driver-cash", {
        cache: "no-store",
      }),
      body = await response.json();
    if (!response.ok)
      throw new Error(body.error || "Could not load driver cash-out.");
    setData(body);
  }
  useEffect(() => {
    void load().catch((error) => setMessage(error.message));
  }, []);
  const orders: Order[] = data?.orders || [],
    chosen = orders.filter((order) => selected.includes(order.order_id)),
    expected = chosen.reduce(
      (sum, order) => sum + Number(order.amount_due_cents),
      0,
    );
  const allSelected =
    orders.length > 0 &&
    orders.every((order) => selected.includes(order.order_id));
  const turnedInCents = turnedIn
    ? Math.round(Number(turnedIn) * 100)
    : 0;

  function cashNumpad(key: string) {
    setTurnedIn((current) => {
      if (key === "clear") return "";
      if (key === "backspace") return current.slice(0, -1);
      if (key === ".") return current.includes(".") ? current : `${current || "0"}.`;
      const decimals = current.split(".")[1];
      if (decimals?.length >= 2) return current;
      if (current === "0") return key;
      return `${current}${key}`;
    });
  }

  function setQuickCash(amountCents: number) {
    setTurnedIn((amountCents / 100).toFixed(2));
  }
  async function post() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/ordering/driver-cash", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orderIds: selected,
            turnedInCashCents: Math.round(Number(turnedIn) * 100),
            businessDate: new Intl.DateTimeFormat("en-CA", {
              timeZone: "America/New_York",
            }).format(new Date()),
          }),
        }),
        body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Could not post cash-out.");
      setMessage(
        `${body.handledByName}: ${body.orderCount} orders posted · ${money(body.expectedCashCents)} expected · ${money(body.overShortCents)} over/short.`,
      );
      setSelected([]);
      setTurnedIn("");
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not post cash-out.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="posSettingsCard">
      <header>
        <a href="/pos/deli">← Cashier POS</a>
        <h1>Driver bulk cash-out</h1>
        <p>
          Select any eligible delivery cash order, even when the driver did not use the delivery app. The system totals the orders
          and posts one audited end-of-shift settlement under the employee currently signed into this POS.
        </p>
      </header>
      {message && <p role="status">{message}</p>}
      {data?.handledBy && <p><strong>CASHING OUT AS: {data.handledBy}</strong></p>}
      <div className="driverCashWorkspace">
        <section className="driverCashOrders" aria-labelledby="eligible-deliveries-title">
          <div className="driverCashSectionTitle">
            <div>
              <h2 id="eligible-deliveries-title">Eligible deliveries</h2>
              <small>{selected.length} of {orders.length} selected</small>
            </div>
            <label className="cashSelectAll">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? orders.map((order) => order.order_id)
                      : [],
                  )
                }
              /> Select all
            </label>
          </div>
          {orders.length>0&&<div className="driverCashGrid">
            <div className="driverCashHead"><span>ORDER</span><span>CUSTOMER / ADDRESS</span><span>DISPATCH</span><span>AMOUNT</span></div>
            {orders.map((order) => (
            <article className={selected.includes(order.order_id)?"selected":""} key={order.order_id}>
              <label className="driverCashRow">
                <input
                  type="checkbox"
                  checked={selected.includes(order.order_id)}
                  onChange={(event) =>
                    setSelected((rows) =>
                      event.target.checked
                        ? [...rows, order.order_id]
                        : rows.filter((id) => id !== order.order_id),
                    )
                  }
                />
                <strong>#{order.display_number}</strong>
                <span><b>{order.customer_name}</b><small>{order.delivery_address}{order.delivery_unit ? ` · ${order.delivery_unit}` : ""}</small></span>
                <span>{order.delivery_status?.replaceAll("_", " ") || "App not used"}</span>
                <b>{money(Number(order.amount_due_cents))}</b>
              </label>
            </article>
          ))}</div>}
          {!orders.length && <p>No unpaid delivery orders are eligible for cash-out.</p>}
        </section>

        <section className="driverCashCheckout" aria-labelledby="driver-checkout-title">
          <div className="driverCashCheckoutHeader">
            <small id="driver-checkout-title">DRIVER CASH CHECKOUT</small>
            <strong>{money(expected)}</strong>
            <span>{selected.length} {selected.length === 1 ? "order" : "orders"}</span>
          </div>
          <div className="driverCashAmount">
            <small>CASH TURNED IN</small>
            <output aria-live="polite">{turnedIn ? money(turnedInCents) : "$0.00"}</output>
          </div>
          <div className="driverCashQuick" aria-label="Quick cash amounts">
            <button type="button" disabled={!selected.length} onClick={() => setQuickCash(expected)}>EXACT</button>
            {[2000, 5000, 10000].map((amount) => (
              <button type="button" key={amount} onClick={() => setQuickCash(amount)}>{money(amount)}</button>
            ))}
          </div>
          <div className="driverCashNumpad" aria-label="Cash amount keypad">
            {["1","2","3","4","5","6","7","8","9","clear","0",".","backspace"].map((key) => (
              <button
                type="button"
                key={key}
                className={key === "0" ? "zero" : ""}
                aria-label={key === "backspace" ? "Backspace" : key === "clear" ? "Clear cash amount" : key}
                onClick={() => cashNumpad(key)}
              >
                {key === "backspace" ? "⌫" : key === "clear" ? "CLEAR" : key}
              </button>
            ))}
          </div>
          <div className={`driverCashVariance ${turnedInCents - expected < 0 ? "short" : turnedInCents - expected > 0 ? "over" : "exact"}`}>
            <span>OVER / SHORT</span><strong>{money(turnedInCents - expected)}</strong>
          </div>
          <button
            className="driverCashPost"
            disabled={busy || !selected.length || !turnedIn || !Number.isFinite(Number(turnedIn))}
            onClick={() => void post()}
          >
            {busy ? "POSTING…" : `CASH OUT ${selected.length || ""} ${selected.length === 1 ? "ORDER" : "ORDERS"}`}
          </button>
        </section>
      </div>
      {data?.settlements?.length > 0 && (
        <section>
          <h2>Recent settlements</h2>
          {data.settlements.map((row: any) => (
            <p key={row.id}>
              {row.handled_by_name} · {row.business_date} · {row.order_count} orders
              · {money(Number(row.expected_cash_cents))} expected ·{" "}
              {money(Number(row.over_short_cents))} over/short
            </p>
          ))}
        </section>
      )}
      <style jsx>{`.driverCashWorkspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(310px,390px);align-items:start;gap:16px}.driverCashOrders,.driverCashCheckout{min-width:0;padding:14px;border:1px solid #475569;border-radius:12px;background:#0b1220;color:#fff}.driverCashSectionTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.driverCashSectionTitle h2{margin:0}.driverCashSectionTitle small{color:#94a3b8}.cashSelectAll{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #475569;border-radius:8px;background:#172033;color:#fff;font-weight:900}.cashSelectAll input{width:20px;height:20px}.driverCashGrid{overflow:hidden;border:1px solid #475569;border-radius:10px;background:#0f172a;color:#fff}.driverCashHead,.driverCashRow{display:grid;grid-template-columns:24px minmax(80px,.65fr) minmax(190px,2fr) minmax(100px,.8fr) minmax(80px,.6fr);align-items:center;gap:10px}.driverCashHead{grid-template-columns:minmax(80px,.65fr) minmax(190px,2fr) minmax(100px,.8fr) minmax(80px,.6fr);margin-left:34px;padding:9px 12px;background:#1e293b;color:#94a3b8;font-size:.7rem;font-weight:900;letter-spacing:.08em}.driverCashGrid article{margin:0;padding:0;border:0;border-top:1px solid #334155;border-radius:0;background:#111827}.driverCashGrid article.selected{background:#12345a;box-shadow:inset 5px 0 #3b82f6}.driverCashRow{min-height:66px;padding:8px 12px;cursor:pointer}.driverCashRow:hover{background:#1e293b}.driverCashRow span{display:flex;min-width:0;flex-direction:column;gap:3px}.driverCashRow small{overflow:hidden;color:#cbd5e1;text-overflow:ellipsis;white-space:nowrap}.driverCashRow>span:nth-last-child(2){text-transform:capitalize;color:#bfdbfe}.driverCashRow>input{width:20px;height:20px}.driverCashRow>b:last-child{text-align:right;color:#86efac;font-size:1.05rem}.driverCashCheckout{position:sticky;top:12px;display:grid;gap:10px}.driverCashCheckoutHeader{display:grid;grid-template-columns:1fr auto;align-items:end;padding-bottom:10px;border-bottom:1px solid #334155}.driverCashCheckoutHeader small{font-weight:950;letter-spacing:.08em;color:#93c5fd}.driverCashCheckoutHeader strong{grid-row:span 2;font-size:1.8rem;color:#86efac}.driverCashCheckoutHeader span{color:#cbd5e1}.driverCashAmount{display:grid;gap:4px}.driverCashAmount small{font-weight:900;color:#cbd5e1}.driverCashAmount output{padding:12px;border:2px solid #60a5fa;border-radius:10px;background:#020617;text-align:right;font-size:2rem;font-weight:950}.driverCashQuick{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.driverCashQuick button{min-height:44px;background:#1e3a5f}.driverCashNumpad{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.driverCashNumpad button{min-height:54px;font-size:1.2rem;font-weight:900}.driverCashNumpad button.zero{grid-column:span 2}.driverCashVariance{display:flex;justify-content:space-between;padding:10px 12px;border-radius:8px;background:#172033;font-weight:900}.driverCashVariance.short{color:#fca5a5}.driverCashVariance.over{color:#fde68a}.driverCashVariance.exact{color:#86efac}.driverCashPost{min-height:58px;background:#15803d;border-color:#4ade80;font-size:1.05rem;font-weight:950}.driverCashPost:disabled{background:#334155;border-color:#475569}@media(max-width:980px){.driverCashWorkspace{grid-template-columns:1fr}.driverCashCheckout{position:static}}@media(max-width:700px){.driverCashHead{display:none}.driverCashRow{grid-template-columns:24px 78px minmax(140px,1fr) 78px}.driverCashRow>span:nth-last-child(2){display:none}.driverCashOrders,.driverCashCheckout{padding:10px}.driverCashSectionTitle{align-items:flex-start;flex-direction:column}.cashSelectAll{width:100%}}`}</style>
    </main>
  );
}

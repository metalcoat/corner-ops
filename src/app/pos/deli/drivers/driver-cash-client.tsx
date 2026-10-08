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
type SettlementSummary = {
  orderCount: number;
  expectedCashCents: number;
  turnedInCashCents: number;
  overShortCents: number;
  handledByName?: string;
  posted: boolean;
};
export default function DriverCashClient() {
  const [data, setData] = useState<any>(null),
    [selected, setSelected] = useState<string[]>([]),
    [turnedIn, setTurnedIn] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [settlement, setSettlement] = useState<SettlementSummary | null>(null);
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
  function reviewSettlement() {
    if (!selected.length || !turnedIn || !Number.isFinite(Number(turnedIn))) return;
    setSettlement({
      orderCount: selected.length,
      expectedCashCents: expected,
      turnedInCashCents: turnedInCents,
      overShortCents: turnedInCents - expected,
      posted: false,
    });
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
      setSettlement({
        orderCount: Number(body.orderCount),
        expectedCashCents: Number(body.expectedCashCents),
        turnedInCashCents: Number(body.turnedInCashCents ?? turnedInCents),
        overShortCents: Number(body.overShortCents),
        handledByName: String(body.handledByName || ""),
        posted: true,
      });
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
  const variance = turnedInCents - expected;
  return (
    <main className="posSettingsCard driverCashPage">
      <header className="driverCashHeader">
        <a className="driverCashBack" href="/pos/deli">← Cashier POS</a>
        <div className="driverCashTitle">
          <small>DELIVERY CASH</small>
          <h1>Driver bulk cash-out</h1>
          <p>
            Select any eligible delivery cash order, even when the driver did not use the delivery app. The system totals the orders
            and posts one audited end-of-shift settlement under the employee currently signed into this POS.
          </p>
        </div>
        {data?.handledBy && (
          <div className="driverCashWho">
            <small>CASHING OUT AS</small>
            <strong>{data.handledBy}</strong>
          </div>
        )}
      </header>
      {message && <p className="driverCashMessage" role="status">{message}</p>}
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
                disabled={!orders.length}
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
                <span><em className={`driverCashStatus ${order.delivery_status ? order.delivery_status.toLowerCase() : "none"}`}>{order.delivery_status?.replaceAll("_", " ").toLowerCase() || "App not used"}</em></span>
                <b>{money(Number(order.amount_due_cents))}</b>
              </label>
            </article>
          ))}</div>}
          {!orders.length && (
            <div className="driverCashEmpty">
              <strong>No delivery cash to settle</strong>
              <span>Unpaid delivery orders appear here once they are sent to the kitchen.</span>
            </div>
          )}
        </section>

        <section className="driverCashCheckout" aria-labelledby="driver-checkout-title">
          <div className="driverCashCheckoutHeader">
            <small id="driver-checkout-title">DRIVER CASH CHECKOUT</small>
            <strong>{money(expected)}</strong>
            <span>Expected from {selected.length} {selected.length === 1 ? "order" : "orders"}</span>
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
            {["1","2","3","4","5","6","7","8","9",".","0","backspace","clear"].map((key) => (
              <button
                type="button"
                key={key}
                className={key === "clear" ? "clear" : ""}
                aria-label={key === "backspace" ? "Backspace" : key === "clear" ? "Clear cash amount" : key}
                onClick={() => cashNumpad(key)}
              >
                {key === "backspace" ? "⌫" : key === "clear" ? "CLEAR" : key}
              </button>
            ))}
          </div>
          <div className={`driverCashVariance ${variance < 0 ? "short" : variance > 0 ? "over" : "exact"}`}>
            <span>{variance < 0 ? "DRIVER IS SHORT" : variance > 0 ? "GIVE BACK TO DRIVER" : "OVER / SHORT"}</span><strong>{money(Math.abs(variance))}</strong>
          </div>
          <button
            className="driverCashPost"
            disabled={busy || !selected.length || !turnedIn || !Number.isFinite(Number(turnedIn))}
            onClick={reviewSettlement}
          >
            {busy ? "POSTING…" : `CASH OUT ${selected.length || ""} ${selected.length === 1 ? "ORDER" : "ORDERS"}`}
          </button>
        </section>
      </div>
      {settlement && (
        <div className="driverSettlementBackdrop">
          <section className="driverSettlementModal" role="alertdialog" aria-modal="true" aria-labelledby="driver-settlement-title">
            <small id="driver-settlement-title">{settlement.posted ? "DRIVER CASH SETTLED" : "CONFIRM DRIVER CASH"}</small>
            <strong>{settlement.orderCount} {settlement.orderCount === 1 ? "ORDER" : "ORDERS"}</strong>
            <div><span>EXPECTED FROM ORDERS</span><b>{money(settlement.expectedCashCents)}</b></div>
            <div><span>CASH RECEIVED</span><b>{money(settlement.turnedInCashCents)}</b></div>
            {settlement.overShortCents > 0 ? (
              <div className="return"><span>CASH TO GIVE BACK TO DRIVER</span><b>{money(settlement.overShortCents)}</b></div>
            ) : settlement.overShortCents < 0 ? (
              <div className="short"><span>DRIVER IS SHORT</span><b>{money(Math.abs(settlement.overShortCents))}</b></div>
            ) : (
              <div className="exact"><span>SETTLEMENT</span><b>EXACT CASH</b></div>
            )}
            {settlement.posted ? (
              <button type="button" autoFocus onClick={() => setSettlement(null)}>DONE</button>
            ) : (
              <footer>
                <button type="button" onClick={() => setSettlement(null)}>BACK</button>
                <button type="button" className="confirm" disabled={busy} onClick={() => void post()}>{busy ? "POSTING…" : "CONFIRM & POST SETTLEMENT"}</button>
              </footer>
            )}
          </section>
        </div>
      )}
      {data?.settlements?.length > 0 && (
        <section className="driverCashRecent" aria-labelledby="recent-settlements-title">
          <h2 id="recent-settlements-title">Recent settlements</h2>
          <table>
            <thead><tr><th>Handled by</th><th>Business date</th><th>Orders</th><th>Expected</th><th>Over / short</th></tr></thead>
            <tbody>
              {data.settlements.map((row: any) => (
                <tr key={row.id}>
                  <td>{row.handled_by_name}</td>
                  <td>{row.business_date}</td>
                  <td>{row.order_count}</td>
                  <td>{money(Number(row.expected_cash_cents))}</td>
                  <td className={Number(row.over_short_cents) < 0 ? "short" : Number(row.over_short_cents) > 0 ? "over" : ""}>{money(Number(row.over_short_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <style jsx>{`.driverSettlementBackdrop{position:fixed;z-index:300;inset:0;display:grid;place-items:center;padding:20px;background:#020617e8}.driverSettlementModal{width:min(520px,96vw);display:grid;gap:12px;padding:24px;border:3px solid #4ade80;border-radius:16px;background:#0b1220;color:#fff;box-shadow:0 24px 80px #000}.driverSettlementModal>small{color:#bbf7d0;font-weight:950;letter-spacing:.12em}.driverSettlementModal>strong{font-size:1.5rem}.driverSettlementModal>div{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:12px;border:1px solid #475569;border-radius:9px;background:#020617}.driverSettlementModal>div span{font-size:.76rem;font-weight:900;color:#cbd5e1}.driverSettlementModal>div b{font-size:1.35rem}.driverSettlementModal>div.return{border-color:#facc15;color:#fde68a}.driverSettlementModal>div.short{border-color:#f87171;color:#fecaca}.driverSettlementModal>div.exact{border-color:#4ade80;color:#bbf7d0}.driverSettlementModal footer{display:grid;grid-template-columns:1fr 2fr;gap:9px}.driverSettlementModal button{min-height:58px;font-weight:950}.driverSettlementModal .confirm,.driverSettlementModal>button{background:#15803d;border-color:#4ade80}`}</style>
      <style jsx>{`.driverCashPage{display:grid;gap:16px;padding:18px 20px 32px;color:#e2e8f0}.driverCashHeader{display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:16px;padding:18px 20px;border:1px solid #1e293b;border-radius:18px;background:radial-gradient(120% 160% at 0% 0%,#14284d 0%,#0d1a33 50%,#0b1220 100%)}.driverCashBack{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border:1px solid #334155;border-radius:999px;background:#0b1220;color:#bfdbfe;font-weight:800;text-decoration:none;white-space:nowrap}.driverCashTitle{display:grid;gap:4px;min-width:0}.driverCashTitle small{color:#60a5fa;font-size:.72rem;font-weight:900;letter-spacing:.16em}.driverCashTitle h1{margin:0;font-size:1.9rem;font-weight:900;letter-spacing:-.01em;color:#fff}.driverCashTitle p{margin:2px 0 0;max-width:70ch;color:#94a3b8;line-height:1.45}.driverCashWho{display:grid;gap:2px;padding:10px 14px;border:1px solid #166534;border-radius:14px;background:#052e16;text-align:right}.driverCashWho small{color:#86efac;font-size:.68rem;font-weight:900;letter-spacing:.14em}.driverCashWho strong{color:#fff;font-size:1.05rem}.driverCashMessage{margin:0;padding:12px 14px;border:1px solid #1d4ed8;border-left-width:4px;border-radius:12px;background:#0f1f3d;color:#dbeafe;font-weight:700}.driverCashWorkspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,400px);align-items:start;gap:16px}.driverCashOrders,.driverCashCheckout{min-width:0;padding:16px;border:1px solid #1e293b;border-radius:18px;background:#0b1424;color:#fff}.driverCashSectionTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.driverCashSectionTitle h2{margin:0;font-size:1.25rem}.driverCashSectionTitle small{color:#94a3b8;font-weight:700}.cashSelectAll{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:1px solid #334155;border-radius:999px;background:#111c31;color:#fff;font-weight:900}.cashSelectAll input{width:20px;height:20px;accent-color:#3b82f6}.driverCashGrid{overflow:hidden;border:1px solid #1e293b;border-radius:14px;background:#0f172a;color:#fff}.driverCashHead,.driverCashRow{display:grid;grid-template-columns:24px minmax(80px,.65fr) minmax(190px,2fr) minmax(110px,.8fr) minmax(80px,.6fr);align-items:center;gap:12px}.driverCashHead{grid-template-columns:minmax(80px,.65fr) minmax(190px,2fr) minmax(110px,.8fr) minmax(80px,.6fr);margin-left:36px;padding:10px 14px;background:#111c31;color:#64748b;font-size:.68rem;font-weight:900;letter-spacing:.12em}.driverCashHead span:last-child{text-align:right}.driverCashGrid article{margin:0;padding:0;border:0;border-top:1px solid #1e293b;border-radius:0;background:#0f172a;transition:background .12s}.driverCashGrid article.selected{background:#10264a;box-shadow:inset 4px 0 #3b82f6}.driverCashRow{min-height:68px;padding:8px 14px;cursor:pointer}.driverCashRow:hover{background:#13213a}.driverCashRow>strong{font-size:1.05rem;font-variant-numeric:tabular-nums}.driverCashRow span{display:flex;min-width:0;flex-direction:column;gap:3px}.driverCashRow small{overflow:hidden;color:#94a3b8;text-overflow:ellipsis;white-space:nowrap}.driverCashRow>input{width:22px;height:22px;accent-color:#3b82f6}.driverCashRow>b:last-child{text-align:right;color:#86efac;font-size:1.1rem;font-variant-numeric:tabular-nums}.driverCashStatus{align-self:flex-start;padding:4px 10px;border:1px solid #1d4ed8;border-radius:999px;background:#0f1f3d;color:#bfdbfe;font-size:.74rem;font-style:normal;font-weight:800;text-transform:capitalize}.driverCashStatus.delivered{border-color:#166534;background:#052e16;color:#86efac}.driverCashStatus.none{border-color:#334155;background:#111827;color:#94a3b8}.driverCashEmpty{display:grid;place-items:center;gap:6px;min-height:200px;padding:24px;border:1px dashed #334155;border-radius:14px;text-align:center}.driverCashEmpty strong{color:#e2e8f0;font-size:1.1rem}.driverCashEmpty span{color:#94a3b8}.driverCashCheckout{position:sticky;top:12px;display:grid;gap:12px}.driverCashCheckoutHeader{display:grid;gap:2px;padding:16px;border:1px solid #166534;border-radius:16px;background:radial-gradient(120% 140% at 0% 0%,#14532d 0%,#0b2a1a 55%,#0b1220 100%)}.driverCashCheckoutHeader small{font-size:.72rem;font-weight:900;letter-spacing:.14em;color:#86efac}.driverCashCheckoutHeader strong{font-size:2.6rem;line-height:1.05;color:#fff;font-variant-numeric:tabular-nums;letter-spacing:-.02em}.driverCashCheckoutHeader span{color:#cbd5e1;font-weight:700}.driverCashAmount{display:grid;gap:6px}.driverCashAmount small{color:#94a3b8;font-size:.72rem;font-weight:900;letter-spacing:.14em}.driverCashAmount output{padding:14px 16px;border:2px solid #2563eb;border-radius:14px;background:#020617;text-align:right;font-size:2.2rem;font-weight:900;font-variant-numeric:tabular-nums;box-shadow:inset 0 2px 10px #0008}.driverCashQuick{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.driverCashQuick button{min-height:46px;border:1px solid #1d4ed8;border-radius:999px;background:#0f1f3d;color:#bfdbfe;font-weight:900}.driverCashQuick button:disabled{opacity:.4}.driverCashNumpad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.driverCashNumpad button{min-height:56px;border:1px solid #334155;border-radius:14px;background:linear-gradient(180deg,#273449 0%,#1c2638 100%);box-shadow:inset 0 1px 0 #ffffff12,0 2px 0 #020617;color:#f8fafc;font-size:1.4rem;font-weight:900;font-variant-numeric:tabular-nums}.driverCashNumpad button:active{transform:translateY(1px);box-shadow:inset 0 1px 0 #ffffff12}.driverCashNumpad button.clear{grid-column:1/-1;min-height:46px;background:#1a1f2b;color:#fca5a5;font-size:.95rem;letter-spacing:.1em}.driverCashVariance{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border:1px solid #334155;border-radius:12px;background:#111c31;font-weight:900}.driverCashVariance span{font-size:.74rem;letter-spacing:.12em}.driverCashVariance strong{font-size:1.25rem;font-variant-numeric:tabular-nums}.driverCashVariance.short{border-color:#7f1d1d;background:#1f0f12;color:#fca5a5}.driverCashVariance.over{border-color:#854d0e;background:#1f1708;color:#fde68a}.driverCashVariance.exact{border-color:#166534;background:#0b1f15;color:#86efac}.driverCashPost{min-height:64px;border-radius:14px;background:#15803d;border-color:#4ade80;font-size:1.1rem;font-weight:900;letter-spacing:.06em;box-shadow:inset 0 1px 0 #ffffff26,0 6px 16px #02061799}.driverCashPost:disabled{background:#1e293b;border-color:#334155;color:#64748b;box-shadow:none}.driverCashRecent{padding:16px;border:1px solid #1e293b;border-radius:18px;background:#0b1424}.driverCashRecent h2{margin:0 0 12px;font-size:1.15rem}.driverCashRecent table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}.driverCashRecent th{padding:8px 10px;color:#64748b;font-size:.68rem;font-weight:900;letter-spacing:.12em;text-align:left;text-transform:uppercase;border-bottom:1px solid #1e293b}.driverCashRecent td{padding:10px;border-bottom:1px solid #16213a;color:#e2e8f0}.driverCashRecent td.short{color:#fca5a5}.driverCashRecent td.over{color:#fde68a}@media(max-width:980px){.driverCashWorkspace{grid-template-columns:1fr}.driverCashCheckout{position:static}.driverCashHeader{grid-template-columns:1fr}.driverCashWho{text-align:left}}@media(max-width:700px){.driverCashPage{padding:12px}.driverCashHead{display:none}.driverCashRow{grid-template-columns:24px 78px minmax(140px,1fr) 78px}.driverCashRow>span:nth-last-child(2){display:none}.driverCashOrders,.driverCashCheckout{padding:12px}.driverCashSectionTitle{align-items:flex-start;flex-direction:column}.cashSelectAll{width:100%}.driverCashRecent{overflow-x:auto}}`}</style>
    </main>
  );
}

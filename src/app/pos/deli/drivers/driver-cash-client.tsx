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
  delivered_at: string;
};
export default function DriverCashClient() {
  const [data, setData] = useState<any>(null),
    [driverId, setDriverId] = useState(""),
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
    if (!driverId && body.drivers[0]) setDriverId(body.drivers[0].id);
  }
  useEffect(() => {
    void load().catch((error) => setMessage(error.message));
  }, []);
  useEffect(() => {
    setSelected([]);
    setTurnedIn("");
  }, [driverId]);
  const orders: Order[] = (data?.orders || []).filter(
      (order: Order) => order.driver_employee_id === driverId,
    ),
    chosen = orders.filter((order) => selected.includes(order.order_id)),
    expected = chosen.reduce(
      (sum, order) => sum + Number(order.amount_due_cents),
      0,
    );
  const allSelected =
    orders.length > 0 &&
    orders.every((order) => selected.includes(order.order_id));
  async function post() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/ordering/driver-cash", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            driverId,
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
        `${body.driverName}: ${body.orderCount} orders posted · ${money(body.expectedCashCents)} expected · ${money(body.overShortCents)} over/short.`,
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
          Select each delivered cash order once. The system totals the orders
          and posts one audited end-of-shift settlement.
        </p>
      </header>
      {message && <p role="status">{message}</p>}
      <label>
        DRIVER
        <select
          value={driverId}
          onChange={(event) => setDriverId(event.target.value)}
        >
          <option value="">Choose driver</option>
          {data?.drivers.map((driver: any) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
        </select>
      </label>
      <div>
        <label>
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
          />{" "}
          Select all eligible orders
        </label>
        {orders.map((order) => (
          <article key={order.order_id}>
            <label>
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
              />{" "}
              #{order.display_number} · {order.customer_name} ·{" "}
              {money(Number(order.amount_due_cents))}
            </label>
          </article>
        ))}
        {driverId && !orders.length && (
          <p>No delivered unpaid orders are eligible for this driver.</p>
        )}
      </div>
      <h2>Expected cash: {money(expected)}</h2>
      <label>
        CASH TURNED IN
        <input
          inputMode="decimal"
          value={turnedIn}
          onChange={(event) => setTurnedIn(event.target.value)}
          placeholder="0.00"
        />
      </label>
      <p>
        Over / short preview:{" "}
        {money(Math.round(Number(turnedIn || 0) * 100) - expected)}
      </p>
      <button
        disabled={
          busy || !selected.length || !Number.isFinite(Number(turnedIn))
        }
        onClick={() => void post()}
      >
        {busy ? "POSTING…" : "POST DRIVER CASH-OUT"}
      </button>
      {data?.settlements?.length > 0 && (
        <section>
          <h2>Recent settlements</h2>
          {data.settlements.map((row: any) => (
            <p key={row.id}>
              {row.driver_name} · {row.business_date} · {row.order_count} orders
              · {money(Number(row.expected_cash_cents))} expected ·{" "}
              {money(Number(row.over_short_cents))} over/short
            </p>
          ))}
        </section>
      )}
    </main>
  );
}

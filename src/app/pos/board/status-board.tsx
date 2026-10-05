"use client";
// The staff status monitor: every open order in one of four columns, big
// enough to read across the deli, plus the things that need someone now.
import { useCallback, useEffect, useState } from "react";

type OpenOrder = {
  id: string;
  display_number: string;
  status: string;
  service_type: string;
  timing_mode: string;
  scheduled_for: string | null;
  created_at: string;
  customer_name: string;
  item_count: number;
  delivery_status: string | null;
  driver_name: string | null;
};
type Board = {
  generatedAt: string;
  openOrders: OpenOrder[];
  tasks: Array<{ key: string; label: string; count: number }>;
};

const SERVICE: Record<string, string> = { pickup: "Pickup", delivery: "Delivery", no_contact_delivery: "Delivery", curbside: "Curbside", dine_in: "Dine in", bar: "Bar" };
const DELIVERY_STEP: Record<string, string> = { PICKED_UP: "In the car", EN_ROUTE: "On the way", ARRIVED: "At the door", NO_CONTACT: "No answer", DELIVERY_FAILED: "Problem" };
const clock = (value: string | Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const isDelivery = (order: OpenOrder) => order.service_type === "delivery" || order.service_type === "no_contact_delivery";

/** Where an order sits on the board. */
function column(order: OpenOrder, now: number) {
  const out = ["PICKED_UP", "EN_ROUTE", "ARRIVED", "NO_CONTACT", "DELIVERY_FAILED"].includes(order.delivery_status || "");
  if (out) return "out";
  if (order.status === "ready") return "ready";
  if (order.timing_mode === "future" && order.scheduled_for && new Date(order.scheduled_for).getTime() - now > 45 * 60_000 && order.status === "confirmed") return "later";
  return "making";
}

export default function StatusBoard() {
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ordering/store-dashboard", { cache: "no-store" });
      if (response.status === 401) {
        window.dispatchEvent(new Event("corner-ops-screen-signed-out"));
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Board unavailable.");
      setData(body);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Board unavailable.");
    }
  }, []);
  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 10_000);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [load]);

  const orders = data?.openOrders ?? [];
  const columns = {
    making: orders.filter((order) => column(order, now) === "making"),
    ready: orders.filter((order) => column(order, now) === "ready"),
    out: orders.filter((order) => column(order, now) === "out"),
    later: orders.filter((order) => column(order, now) === "later"),
  };
  const minutes = (order: OpenOrder) => Math.max(0, Math.round((now - new Date(order.created_at).getTime()) / 60_000));
  const late = columns.making.filter((order) => order.timing_mode !== "future" && minutes(order) >= 30).length;
  const alerts = [
    ...(data?.tasks ?? [])
      .filter((task) => task.count > 0 && ["unassigned", "problems"].includes(task.key))
      .map((task) =>
        task.key === "unassigned"
          ? `${task.count} ${task.count === 1 ? "delivery needs" : "deliveries need"} a driver`
          : `${task.count} delivery ${task.count === 1 ? "problem" : "problems"} — check with the driver`,
      ),
    ...(late ? [`${late} order${late === 1 ? "" : "s"} waiting over 30 min`] : []),
  ];

  const card = (order: OpenOrder, place: keyof typeof columns) => {
    const age = minutes(order);
    const tone = place === "making" && order.timing_mode !== "future" ? (age >= 30 ? "late" : age >= 15 ? "warn" : "") : "";
    let detail = "";
    if (place === "later" || (order.timing_mode === "future" && order.scheduled_for)) detail = `Due ${clock(order.scheduled_for!)}`;
    else detail = `${age} min`;
    let status = "";
    if (place === "making") status = order.status === "in_progress" ? "Making" : "New";
    if (place === "ready") status = isDelivery(order) ? (order.driver_name ? `Driver: ${order.driver_name.split(" ")[0]}` : "Needs a driver") : `Ready for ${SERVICE[order.service_type]?.toLowerCase() || "pickup"}`;
    if (place === "out") status = `${order.driver_name?.split(" ")[0] || "Driver"} · ${DELIVERY_STEP[order.delivery_status || ""] || "Out"}`;
    return (
      <article key={order.id} className={`boardCard ${tone} ${order.delivery_status === "DELIVERY_FAILED" || order.delivery_status === "NO_CONTACT" ? "problem" : ""} ${place === "ready" && isDelivery(order) && !order.driver_name ? "needsDriver" : ""}`}>
        <div className="boardCardTop">
          <strong>#{order.display_number}</strong>
          <span className={`boardService ${order.service_type}`}>{SERVICE[order.service_type] || order.service_type}</span>
        </div>
        <div className="boardName">{order.customer_name}</div>
        <div className="boardMeta">
          <span>{status}</span>
          <span>
            {order.item_count} item{order.item_count === 1 ? "" : "s"} · {detail}
          </span>
        </div>
      </article>
    );
  };

  return (
    <main className="statusBoard">
      <header className="boardHeader">
        <div>
          <p>CORNER DELI</p>
          <h1>Orders</h1>
        </div>
        <div className={`boardAlerts${alerts.length ? " on" : ""}`}>{alerts.length ? alerts.map((alert) => <span key={alert}>⚠ {alert}</span>) : <span>All good</span>}</div>
        <div className="boardClock">
          <strong>{clock(new Date(now))}</strong>
          <small>{error ? "Reconnecting…" : data ? `Updated ${clock(data.generatedAt)}` : "Loading…"}</small>
        </div>
      </header>
      <div className="boardColumns">
        {(
          [
            ["making", "In the kitchen"],
            ["ready", "Ready"],
            ["out", "Out for delivery"],
            ["later", "Coming up"],
          ] as const
        ).map(([key, title]) => (
          <section key={key} className={`boardColumn ${key}`}>
            <h2>
              {title} <b>{columns[key].length}</b>
            </h2>
            <div className="boardCards">{columns[key].length ? columns[key].map((order) => card(order, key)) : <p className="boardEmpty">None</p>}</div>
          </section>
        ))}
      </div>
    </main>
  );
}

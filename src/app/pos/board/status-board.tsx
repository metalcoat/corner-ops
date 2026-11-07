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
type CallEvent = { id: string; at: string; callerLast4: string; ringSeconds: number; outcome: "answered" | "missed"; answeredBy: string; calledBackAt: string | null; otherCallsActive: number | null; onClock: Array<{ name: string; position: string }> };
type Calls = {
  total: number; answered: number; missed: number; missedNotCalledBack: number; quickHangups: number; answerRate: number | null;
  avgRingSeconds: number | null; longestRingSeconds: number | null; longRingSeconds: number; longRings: number; aiPhoneOrders: number;
  byHour: Array<{ hour: number; calls: number; missed: number }>; ringingNow: Array<{ since: string; callerLast4: string }>; attention: CallEvent[]; dataAsOf: string | null;
};
type Board = {
  generatedAt: string;
  calls: Calls | null;
  openOrders: OpenOrder[];
  tasks: Array<{ key: string; label: string; count: number }>;
};

const SERVICE: Record<string, string> = { pickup: "Pickup", delivery: "Delivery", no_contact_delivery: "Delivery", curbside: "Curbside", dine_in: "Dine in", bar: "Bar" };
const DELIVERY_STEP: Record<string, string> = { PICKED_UP: "In the car", EN_ROUTE: "On the way", ARRIVED: "At the door", NO_CONTACT: "No answer", DELIVERY_FAILED: "Problem" };
const clock = (value: string | Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const seconds = (s: number | null) => (s == null ? "—" : s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`);
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
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
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
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
    ...(data?.calls?.missedNotCalledBack ? [`${data.calls.missedNotCalledBack} missed call${data.calls.missedNotCalledBack === 1 ? "" : "s"} not called back`] : []),
  ];
  const calls = data?.calls ?? null;
  const ringing = calls?.ringingNow ?? [];
  const peak = Math.max(1, ...(calls?.byHour ?? []).map((h) => h.calls));

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
        <div className="boardMiddle">
        {ringing.length > 0 && (
          <div className="boardRinging" role="alert">
            ☎ PHONE RINGING {ringing.length > 1 ? `(${ringing.length})` : ""} · {seconds(Math.max(0, Math.round((now - new Date(ringing[0].since).getTime()) / 1000)))}
          </div>
        )}
        <div className={`boardAlerts${alerts.length ? " on" : ""}`}>{alerts.length ? alerts.map((alert) => <span key={alert}>⚠ {alert}</span>) : <span>All good</span>}</div>
        </div>
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
      {calls && (
        <section className="boardPhones" aria-label="Phones today">
          <div className="phoneStats">
            <h2>Phones today</h2>
            <dl>
              <div><dt>Calls</dt><dd>{calls.total}</dd></div>
              <div><dt>Answered</dt><dd className={calls.answerRate != null && calls.answerRate < 90 ? "bad" : "good"}>{calls.answerRate == null ? "—" : `${calls.answerRate}%`}</dd></div>
              <div><dt>Missed</dt><dd className={calls.missed ? "bad" : ""}>{calls.missed}{calls.missed ? <small>{calls.missedNotCalledBack} not called back</small> : null}</dd></div>
              <div><dt>Avg ring</dt><dd className={calls.avgRingSeconds != null && calls.avgRingSeconds >= 20 ? "warn" : ""}>{seconds(calls.avgRingSeconds)}</dd></div>
              <div><dt>Longest</dt><dd className={calls.longestRingSeconds != null && calls.longestRingSeconds >= calls.longRingSeconds ? "bad" : ""}>{seconds(calls.longestRingSeconds)}</dd></div>
              <div><dt>Rang {calls.longRingSeconds}s+</dt><dd className={calls.longRings ? "warn" : ""}>{calls.longRings}</dd></div>
              <div><dt>AI phone orders</dt><dd>{calls.aiPhoneOrders}</dd></div>
            </dl>
            {calls.byHour.length > 0 && (
              <div className="phoneHours" aria-label="Calls by hour">
                {calls.byHour.map((h) => (
                  <span key={h.hour} title={`${h.calls} calls, ${h.missed} missed`}>
                    <i style={{ height: `${(h.calls / peak) * 100}%` }}>{h.missed > 0 && <b style={{ height: `${(h.missed / h.calls) * 100}%` }} />}</i>
                    <small>{hourLabel(h.hour)}</small>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="phoneAttention">
            <h2>Missed &amp; long rings</h2>
            {calls.attention.length === 0 ? (
              <p className="boardEmpty">None today. Nice.</p>
            ) : (
              <ul>
                {calls.attention.slice(0, 5).map((call) => (
                  <li key={call.id} className={call.outcome === "missed" ? (call.calledBackAt ? "missed back" : "missed") : "long"}>
                    <div className="callLine">
                      <strong>{clock(call.at)}</strong>
                      <span className="callWhat">
                        {call.outcome === "missed" ? `Missed · rang ${seconds(call.ringSeconds)}` : `Rang ${seconds(call.ringSeconds)} · ${call.answeredBy || "answered"}`}
                      </span>
                      <span className="callWho">···{call.callerLast4 || "????"}</span>
                      {call.outcome === "missed" && <span className={`callBack ${call.calledBackAt ? "yes" : "no"}`}>{call.calledBackAt ? `Called back ${clock(call.calledBackAt)}` : "Not called back"}</span>}
                    </div>
                    <div className="callClock">
                      On the clock: {call.onClock.length ? call.onClock.map((p) => `${p.name.split(" ")[0]}${p.position ? ` (${p.position})` : ""}`).join(", ") : "nobody"}
                      {call.otherCallsActive ? ` · ${call.otherCallsActive} other call${call.otherCallsActive === 1 ? "" : "s"} in progress` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

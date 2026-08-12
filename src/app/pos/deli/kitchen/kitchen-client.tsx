"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PosPinGate, { type PosEmployeeSession, type PosSessionView } from "../../pos-pin-gate";

type KitchenStatus = "sent_to_kitchen" | "in_progress" | "ready" | "completed" | "cancelled";
type KitchenModifier = {
  option_id: string;
  group_name_snapshot: string;
  option_name_snapshot: string;
  quantity: number;
  selection_state: string;
};
type KitchenItem = {
  id: string;
  item_name_snapshot: string;
  variant_name_snapshot: string;
  quantity: number;
  line_total_cents: number;
  special_instructions: string;
  modifiers: KitchenModifier[];
  combo_selections: Array<{ option_id: string; group_name_snapshot: string; option_name_snapshot: string }>;
};
type KitchenOrder = {
  id: string;
  display_number: string;
  status: KitchenStatus;
  payment_status: string;
  service_type: "pickup" | "delivery" | "dine_in";
  total_cents: number;
  special_instructions: string;
  submitted_at: string;
  server_now: string;
  items: KitchenItem[];
};

const statusLabels: Record<KitchenStatus, string> = {
  sent_to_kitchen: "SUBMITTED",
  in_progress: "IN PROGRESS",
  ready: "READY",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
};

const serviceLabels = { pickup: "PICKUP", delivery: "DELIVERY", dine_in: "DINE IN" } as const;

function elapsed(submittedAt: string, serverNow: string, tick: number): string {
  const seconds = Math.max(0, Math.floor((new Date(serverNow).getTime() + tick * 1000 - new Date(submittedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function KitchenClient() {
  const [session, setSession] = useState<PosSessionView | null>(null);
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyOrderId, setBusyOrderId] = useState("");
  const [showRecent, setShowRecent] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/pos/session", { cache: "no-store" }).then((response) => response.json()).then(setSession)
      .catch(() => setSession({ authenticated: false }));
  }, []);

  const loadOrders = useCallback(async (recent = showRecent) => {
    try {
      const response = await fetch(`/api/ordering/kitchen?business=${encodeURIComponent("Corner Deli")}&recent=${recent}`, { cache: "no-store" });
      const payload = await response.json() as { orders?: KitchenOrder[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load kitchen orders.");
      setOrders(payload.orders || []);
      setError("");
      setTick(0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load kitchen orders.");
    } finally {
      setLoading(false);
    }
  }, [showRecent]);

  useEffect(() => {
    if (!session?.authenticated) return;
    void loadOrders();
    const refresh = window.setInterval(() => void loadOrders(), 5_000);
    return () => window.clearInterval(refresh);
  }, [loadOrders, session?.authenticated]);

  useEffect(() => {
    const clock = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(clock);
  }, []);

  const activeCount = useMemo(() => orders.filter((order) => order.status === "sent_to_kitchen" || order.status === "in_progress" || order.status === "ready").length, [orders]);

  async function lockKitchen() {
    await fetch("/api/pos/session", { method: "DELETE" });
    setOrders([]);
    setSession({ authenticated: false });
  }

  async function transition(order: KitchenOrder, nextStatus: KitchenStatus) {
    if (busyOrderId) return;
    setBusyOrderId(order.id);
    setError("");
    try {
      const response = await fetch("/api/ordering/kitchen", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business: "Corner Deli",
          orderId: order.id,
          expectedStatus: order.status,
          nextStatus,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not update the order.");
      await loadOrders();
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : "Could not update the order.");
      await loadOrders();
    } finally {
      setBusyOrderId("");
    }
  }

  if (!session) return <main className="kitchenPage"><div className="kitchenEmpty">Loading employee session…</div></main>;
  if (!session.authenticated) return <PosPinGate onAuthenticated={(employee) => setSession({ authenticated: true, session: employee })} />;
  const employee = session.session as PosEmployeeSession;

  return <main className="kitchenPage">
    <header className="kitchenHeader">
      <div><span>LOCAL DEVELOPMENT</span><h1>Corner Deli Kitchen</h1><p>{activeCount} active order{activeCount === 1 ? "" : "s"}</p></div>
      <nav><strong>{employee.name}</strong><a href="/pos/deli">Cashier POS</a><button type="button" onClick={() => { const next = !showRecent; setShowRecent(next); void loadOrders(next); }}>{showRecent ? "Active only" : "Recent history"}</button><button type="button" onClick={() => void loadOrders()}>Refresh</button><button type="button" onClick={() => void lockKitchen()}>LOCK / SWITCH EMPLOYEE</button></nav>
    </header>
    {error && <div className="kitchenError" role="alert">{error}</div>}
    {loading && <div className="kitchenEmpty">Loading kitchen queue…</div>}
    {!loading && !orders.length && <div className="kitchenEmpty">No active kitchen orders.</div>}
    <section className="kitchenGrid" aria-label="Kitchen orders">
      {orders.map((order) => <article className={`kitchenTicket ${order.status}`} key={order.id} aria-label={`Order ${order.display_number}`}>
        <header>
          <div><strong>#{order.display_number}</strong><span>{statusLabels[order.status]}</span></div>
          <div><b>{serviceLabels[order.service_type]}</b><time>{elapsed(order.submitted_at, order.server_now, tick)}</time></div>
        </header>
        <div className="kitchenItems">
          {order.items.map((item) => <section key={item.id} className="kitchenItem">
            <h2>{item.quantity}× {item.item_name_snapshot}</h2>
            {item.variant_name_snapshot && <h3>{item.variant_name_snapshot}</h3>}
            <ul>
              {item.modifiers.filter((modifier) => modifier.selection_state !== "removed").map((modifier) => <li key={`${modifier.group_name_snapshot}-${modifier.option_id}`}>{modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}{modifier.option_name_snapshot}</li>)}
              {item.modifiers.filter((modifier) => modifier.selection_state === "removed").map((modifier) => <li className="removed" key={`removed-${modifier.option_id}`}>NO {modifier.option_name_snapshot.toUpperCase()}</li>)}
              {item.combo_selections.map((selection) => <li key={`${selection.group_name_snapshot}-${selection.option_id}`}>{selection.option_name_snapshot}</li>)}
            </ul>
            {item.special_instructions && <p className="kitchenNote">NOTE: {item.special_instructions}</p>}
          </section>)}
        </div>
        {order.special_instructions && <p className="kitchenOrderNote">ORDER NOTE: {order.special_instructions}</p>}
        <footer>
          <span>{order.payment_status.toUpperCase()}</span>
          {order.status === "sent_to_kitchen" && <button type="button" disabled={Boolean(busyOrderId)} onClick={() => void transition(order, "in_progress")}>START</button>}
          {order.status === "in_progress" && <button type="button" disabled={Boolean(busyOrderId)} onClick={() => void transition(order, "ready")}>READY</button>}
          {order.status === "ready" && <button type="button" disabled={Boolean(busyOrderId)} onClick={() => void transition(order, "completed")}>COMPLETE</button>}
        </footer>
      </article>)}
    </section>
  </main>;
}

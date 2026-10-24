"use client";
import { randomId } from "@/app/client-id";

import { useCallback, useEffect, useState } from "react";

// Voided orders/items still holding the customer's money. Owner rule: refund it
// or leave it as store credit before the end of the business day.
type Tender = { id: string; tenderType: string; brand: string; last4: string; remainingCents: number };
type Owed = { orderId: string; displayNumber: string; customerName: string; customerId: string | null; status: string; owedCents: number; tenders: Tender[] };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const tenderLabel = (tender: Tender) => `${tender.tenderType.replaceAll("_", " ")}${tender.last4 ? ` ····${tender.last4}` : ""} · ${money(tender.remainingCents)}`;

export default function VoidMoneyPanel({ refreshKey }: { refreshKey: number }) {
  const [orders, setOrders] = useState<Owed[]>([]);
  const [tenderFor, setTenderFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/ordering/order-center/void-money", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const body = (await response.json()) as { orders?: Owed[] };
    setOrders(body.orders || []);
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  async function resolve(order: Owed, method: "refund" | "store_credit") {
    const tender = order.tenders.find((row) => row.id === (tenderFor[order.orderId] || order.tenders[0]?.id));
    if (!tender) return;
    setBusy(`${order.orderId}:${method}`);
    setError("");
    try {
      const response = await fetch("/api/ordering/order-center/void-money", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: order.orderId, transactionId: tender.id, amountCents: Math.min(order.owedCents, tender.remainingCents), method, clientMutationId: randomId() }),
      });
      const body = (await response.json()) as { orders?: Owed[]; error?: string };
      if (!response.ok) throw new Error(body.error || "That didn't go through.");
      setOrders(body.orders || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That didn't go through.");
    } finally {
      setBusy("");
    }
  }

  if (!orders.length) return null;
  return (
    <section className="ocVoidMoney" aria-label="Needs refund or credit">
      <header>
        <strong>NEEDS REFUND OR CREDIT · {orders.length}</strong>
        <span>Voided food the customer paid for. Refund it or leave store credit before closing.</span>
      </header>
      {error && <p className="ocDialogError" role="alert">{error}</p>}
      {orders.map((order) => {
        const tenderId = tenderFor[order.orderId] || order.tenders[0]?.id || "";
        const tender = order.tenders.find((row) => row.id === tenderId);
        const amount = tender ? Math.min(order.owedCents, tender.remainingCents) : 0;
        return (
          <div className="ocVoidMoneyRow" key={order.orderId}>
            <span><b>#{order.displayNumber}</b> {order.customerName} · {order.status === "cancelled" ? "voided order" : "voided items"} · <b>{money(order.owedCents)}</b></span>
            {order.tenders.length > 1 && (
              <select aria-label={`Payment for order ${order.displayNumber}`} value={tenderId} onChange={(event) => setTenderFor({ ...tenderFor, [order.orderId]: event.target.value })}>
                {order.tenders.map((row) => <option key={row.id} value={row.id}>{tenderLabel(row)}</option>)}
              </select>
            )}
            <button type="button" className="danger" disabled={Boolean(busy) || !tender} onClick={() => void resolve(order, "refund")}>
              {busy === `${order.orderId}:refund` ? "REFUNDING…" : `REFUND ${money(amount)}`}
            </button>
            <button type="button" className="primary" disabled={Boolean(busy) || !tender || !order.customerId} title={order.customerId ? "" : "Attach a customer to leave store credit"} onClick={() => void resolve(order, "store_credit")}>
              {busy === `${order.orderId}:store_credit` ? "SAVING…" : `LEAVE ${money(amount)} CREDIT`}
            </button>
          </div>
        );
      })}
    </section>
  );
}

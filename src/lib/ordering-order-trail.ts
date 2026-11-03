/** One line per thing that happened to an order, oldest first, for answering "who did this and when?" */
export type OrderTrailEntry = { at: string; label: string; who: string; detail?: string };

type Event = { event_type?: unknown; created_at?: unknown; actor_name?: unknown; actor_id?: unknown; details?: Record<string, unknown> | null };
type Payment = { created_at?: unknown; transaction_type?: unknown; tender_type?: unknown; amount_cents?: unknown; brand?: unknown; last4?: unknown; taken_by?: unknown; reason?: unknown };

const dollars = (cents: unknown) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const iso = (value: unknown) => new Date(String(value)).toISOString();
const channel = (actorId: string) => (actorId.startsWith("web:") ? "Online" : actorId);
const words = (value: unknown) => String(value || "").replaceAll("_", " ");

/** "Delivery fee $4.00 removed · approved by Pat" for a pickup/delivery switch; empty when nothing changed hands. */
export function fulfillmentChangeDetail(details: Record<string, unknown>): string | undefined {
  const fee = Number(details.deliveryFeeCents || 0), before = Number(details.previousDeliveryFeeCents ?? (details.from === "delivery" ? fee : 0));
  const parts = [
    fee > before ? `Delivery fee ${dollars(fee - before)} added` : fee < before ? `Delivery fee ${dollars(before - fee)} removed` : "",
    details.afterSend ? "after it was sent" : details.afterPayment ? "after it was paid" : "",
    details.approvedByName ? `approved by ${String(details.approvedByName)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export function orderStartedAt(events: Event[], createdAt: unknown): { at: string; exact: boolean } {
  const started = events.find((event) => event.event_type === "order_created")?.details?.orderStartedAt;
  return started ? { at: iso(started), exact: true } : { at: iso(createdAt), exact: false };
}

export function orderTrail(input: { createdAt: unknown; takenBy: unknown; events: Event[]; payments: Payment[] }): OrderTrailEntry[] {
  const who = (event: Event) => channel(String(event.actor_name || event.actor_id || "Unknown"));
  const started = orderStartedAt(input.events, input.createdAt);
  const trail: OrderTrailEntry[] = [{ at: started.at, label: started.exact ? "Order started" : "Order saved", who: String(input.takenBy || "Unknown") }];
  let sent = false;
  for (const event of input.events) {
    const at = iso(event.created_at), details = event.details || {};
    if (event.event_type === "status_changed" && details.to === "sent_to_kitchen") {
      trail.push({ at, label: sent ? "Sent to kitchen again" : "Sent to kitchen", who: who(event) });
      sent = true;
    }
    if (event.event_type === "order_reopened_for_additions") trail.push({ at, label: "Reopened", who: who(event) });
    if (event.event_type === "order_voided") trail.push({ at, label: "Voided", who: who(event), detail: String(details.reason || "") });
    if (event.event_type === "order_item_cancelled") trail.push({ at, label: "Item voided", who: who(event), detail: `${Number(details.quantity || 1)}× ${String(details.itemName || "item")}` });
    if (event.event_type === "order_fulfillment_changed") trail.push({ at, label: details.from === details.to ? "Delivery address changed" : `Changed ${words(details.from)} to ${words(details.to)}`, who: who(event), detail: fulfillmentChangeDetail(details) });
  }
  for (const payment of input.payments) {
    const tender = payment.last4 ? `${String(payment.brand || "Card")} ····${String(payment.last4)}` : words(payment.tender_type);
    const refund = payment.transaction_type !== "payment";
    trail.push({ at: iso(payment.created_at), label: refund ? `Refunded ${dollars(payment.amount_cents)}` : `Payment taken ${dollars(payment.amount_cents)}`, who: channel(String(payment.taken_by || "Unknown")), detail: [tender, refund ? String(payment.reason || "") : ""].filter(Boolean).join(" · ") });
  }
  return trail.sort((a, b) => a.at.localeCompare(b.at));
}

import { carLabel } from "./curbside-arrival-policy";

/** One line per thing that happened to an order, oldest first, for answering "who did this and when?" */
export type OrderTrailEntry = { at: string; label: string; who: string; detail?: string };

type Event = { event_type?: unknown; created_at?: unknown; actor_name?: unknown; actor_id?: unknown; details?: Record<string, unknown> | null };
type Payment = { created_at?: unknown; transaction_type?: unknown; tender_type?: unknown; amount_cents?: unknown; brand?: unknown; last4?: unknown; taken_by?: unknown; reason?: unknown; via?: unknown };

const dollars = (cents: unknown) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const iso = (value: unknown) => new Date(String(value)).toISOString();
const channel = (actorId: string) => (actorId.startsWith("web:") ? "Online" : /^(openai|gemini|ai):/.test(actorId) ? "AI phone" : actorId === "kitchen-release" || actorId === "reopen-sweep" ? "System" : actorId);
const words = (value: unknown) => String(value || "").replaceAll("_", " ");
/** "from manager portal" when it was done remotely rather than at the POS. */
const where = (via: unknown) => (via === "manager_portal" ? "from manager portal" : "");
const joined = (...parts: unknown[]) => parts.map((part) => String(part || "")).filter(Boolean).join(" · ") || undefined;
/** Kitchen screen steps after the first send, by the status the order moved to. */
const statusLabels: Record<string, string> = { in_progress: "Started in kitchen", ready: "Marked ready", completed: "Completed", cancelled: "Cancelled", confirmed: "Confirmed" };

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
    if (event.event_type === "order_voided") trail.push({ at, label: "Voided", who: who(event), detail: joined(details.reason, where(details.via)) });
    // An edit's void is part of the edit: one "Item changed" line, not a void too.
    if (event.event_type === "order_item_cancelled" && details.via !== "line_edit") trail.push({ at, label: "Item voided", who: who(event), detail: joined(`${Number(details.quantity || 1)}× ${String(details.itemName || "item")}`, Number(details.refundCents) > 0 && details.refundMethod !== "later" ? `${dollars(details.refundCents)} refunded` : "", details.reason, where(details.via)) });
    if (event.event_type === "order_item_edited") trail.push({ at, label: details.rootSent ? "Item changed after it was sent" : "Item changed", who: who(event), detail: joined(`${String(details.beforeText || "")} → ${String(details.afterText || "")}`, Number(details.priceAfterCents) !== Number(details.priceBeforeCents) ? `${dollars(details.priceBeforeCents)} → ${dollars(details.priceAfterCents)}` : "", details.rootSent || details.sent ? details.reason : "", details.approvedByName ? `approved by ${String(details.approvedByName)}` : "") });
    if (event.event_type === "curbside_delivered") trail.push({ at, label: "Delivered to car (curbside)", who: who(event), detail: carLabel(String(details.carColor || "Other"), String(details.carType || "Other")) });
    if (event.event_type === "order_fulfillment_changed") trail.push({ at, label: details.from === details.to ? "Delivery address changed" : `Changed ${words(details.from)} to ${words(details.to)}`, who: who(event), detail: fulfillmentChangeDetail(details) });
    if (event.event_type === "status_changed" && statusLabels[String(details.to)]) trail.push({ at, label: statusLabels[String(details.to)], who: who(event) });
    if (event.event_type === "draft_service_changed") trail.push({ at, label: `Changed ${words(details.from)} to ${words(details.to)}`, who: who(event), detail: "before sending" });
    if (event.event_type === "order_addition_submitted") trail.push({ at, label: "Add-on sent to kitchen", who: who(event), detail: details.additionalAmountDueCents ? `${dollars(details.additionalAmountDueCents)} more due` : undefined });
    if (event.event_type === "order_reopen_closed_no_changes") trail.push({ at, label: "Reopen closed with no changes", who: who(event), detail: details.reason === "abandoned_timeout" ? "left open too long" : undefined });
    if (event.event_type === "tip_updated") trail.push({ at, label: `Tip set to ${dollars(details.orderTipCents ?? details.tipCents)}`, who: who(event), detail: `was ${dollars(details.previousTipCents)}` });
    if (event.event_type === "store_credit_applied") trail.push({ at, label: `Store credit used ${dollars(details.amountCents)}`, who: who(event) });
    if (event.event_type === "refund_issued_as_store_credit") trail.push({ at, label: `Refund left as store credit ${dollars(details.creditCents)}`, who: who(event), detail: joined(details.reason, where(details.via)) });
    if (event.event_type === "complaint_remake_created") trail.push({ at, label: "Remake made for a complaint", who: who(event), detail: String(details.reason || "") || undefined });
    if (event.event_type === "complaint_remake_submitted") trail.push({ at, label: `Remake of #${String(details.originalNumber || "?")}`, who: who(event), detail: String(details.reason || "") || undefined });
    if (event.event_type === "custom_item_added") trail.push({ at, label: "Custom item added", who: who(event), detail: `${Number(details.quantity || 1)}× ${String(details.name || "item")} ${dollars(details.priceCents)}` });
    if (event.event_type === "employee_meal_priced") trail.push({ at, label: "Employee meal", who: who(event), detail: `owes ${dollars(details.employeeOwesCents)}` });
    if (event.event_type === "payment_receipt_reprinted") trail.push({ at, label: "Receipt reprinted", who: who(event), detail: String(details.reason || "") || undefined });
    if (event.event_type === "house_account_charged") trail.push({ at, label: `Charged to house account ${dollars(details.amountCents)}`, who: who(event), detail: [String(details.accountName || ""), `tab balance ${dollars(details.balanceAfterCents)}`, String(details.deviceLabel || "")].filter(Boolean).join(" · ") });
    if (event.event_type === "house_account_charge_reversed") trail.push({ at, label: `House-account charge reversed ${dollars(details.amountCents)}`, who: who(event), detail: [String(details.accountName || ""), `tab balance ${dollars(details.balanceAfterCents)}`, String(details.reason || "")].filter(Boolean).join(" · ") });
    if (event.event_type === "kitchen_released") trail.push({ at, label: "Released to kitchen (scheduled order)", who: "System" });
  }
  for (const payment of input.payments) {
    const tender = payment.last4 ? `${String(payment.brand || "Card")} ····${String(payment.last4)}` : words(payment.tender_type);
    const refund = payment.transaction_type !== "payment";
    trail.push({ at: iso(payment.created_at), label: refund ? `Refunded ${dollars(payment.amount_cents)}` : `Payment taken ${dollars(payment.amount_cents)}`, who: channel(String(payment.taken_by || "Unknown")), detail: joined(tender, refund ? payment.reason : "", refund ? where(payment.via) : "") });
  }
  return trail.sort((a, b) => a.at.localeCompare(b.at));
}

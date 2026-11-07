"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { OrderLoyaltyCard } from "@/lib/ordering-loyalty-card";
import "./order-loyalty-card.css";

type CardActivity = OrderLoyaltyCard["thisOrder"];
const number = new Intl.NumberFormat("en-US");
const timestamp = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const signed = (amount: number) => `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${number.format(Math.abs(amount))}`;
const activityLabels: Record<string, string> = {
  earn: "Earned", redeem: "Redeemed", reversal: "Reversed", void_reversal: "Reversed",
  redemption_reversal: "Reward returned", adjustment: "Adjusted", manager_adjustment: "Adjusted", expiry: "Expired",
};
function activityTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? timestamp.format(date) : "Date unavailable";
}

function Activity({ activity, emptyMessage }: { activity: CardActivity; emptyMessage: string }) {
  const events = [
    ...activity.points.map((event) => ({ ...event, unit: "points", source: "points" })),
    ...activity.loyalty.map((event) => ({ ...event, unit: Math.abs(event.amount) === 1 ? "punch" : "punches", source: "loyalty" })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (!events.length) return <p className="ocLoyaltyMuted">{emptyMessage}</p>;
  return <ol className="ocLoyaltyActivity">
    {events.map((event) => <li key={`${event.source}:${event.id}`}>
      <div className="ocLoyaltyEventHeading">
        <strong>{activityLabels[event.type] || "Activity"} · {event.description}</strong>
        <b className={event.amount < 0 ? "ocLoyaltyNegative" : "ocLoyaltyPositive"}>{signed(event.amount)} {event.unit}</b>
      </div>
      <div className="ocLoyaltyEventContext">
        <span>{event.programName || "Points"}{event.orderNumber ? ` · Order #${event.orderNumber}` : ""}</span>
        <time dateTime={event.createdAt || undefined}>{activityTime(event.createdAt)}</time>
      </div>
      {event.reason && event.reason !== event.description && <p>{event.reason}</p>}
    </li>)}
  </ol>;
}

export default function OrderLoyaltyCardButton({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [card, setCard] = useState<OrderLoyaltyCard | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setCard(null);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/ordering/orders/${encodeURIComponent(orderId)}/loyalty-card`, {
          cache: "no-store", signal: controller.signal,
        });
        const body = await response.json() as OrderLoyaltyCard & { error?: string };
        if (!response.ok) throw new Error(body.error || "The loyalty card could not be loaded.");
        if (body.order?.id !== orderId) throw new Error("The loyalty card could not be matched to this order. Please try again.");
        if (!controller.signal.aborted) setCard(body);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The loyalty card could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [open, orderId, attempt]);

  const pointsChange = card?.thisOrder.points.reduce((sum, event) => sum + event.amount, 0) || 0;
  const punchChanges = new Map<string, number>();
  for (const event of card?.thisOrder.loyalty || []) {
    const name = event.programName || "Jumbo";
    punchChanges.set(name, (punchChanges.get(name) || 0) + event.amount);
  }

  return <>
    <button type="button" className="ocLoyaltyButton" onClick={() => setOpen(true)} aria-haspopup="dialog">
      POINTS &amp; JUMBO CARD
    </button>
    <dialog className="ocLoyaltyCard" ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); setOpen(false); }}>
      <header className="ocLoyaltyHeader">
        <div><h2 id={titleId}>Points &amp; Jumbo Card</h2><p>Order #{orderNumber}</p></div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close loyalty card">Close</button>
      </header>
      {open && <div className="ocLoyaltyContent">
        {!card && !error && <p role="status">Loading loyalty card…</p>}
        {error && <div className="ocLoyaltyError"><p role="alert">{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>}
        {card && <>
          {card.customer ? <p className="ocLoyaltyCustomer"><strong>{card.customer.name}</strong>{!card.customer.active && <span> · Inactive customer account</span>}</p> : null}
          {card.notes.length > 0 && <div className="ocLoyaltyNotes">{card.notes.map((note) => <p key={note.code}>{note.message}</p>)}</div>}
          {!card.customer && !card.notes.some((note) => note.code === "no_customer") && <p>No customer account is linked to this order, so a loyalty card is not available.</p>}
          {card.customer && <>
            <section aria-label="Current rewards" className="ocLoyaltyBalances">
              <div className="ocLoyaltyBalance">
                <h3>Points balance</h3>
                <strong className="ocLoyaltyBalanceNumber">{number.format(card.points.balance)} <span>points</span></strong>
                {!card.points.active && <p className="ocLoyaltyMuted">The points program is currently paused.</p>}
                {card.points.expired && <p className="ocLoyaltyMuted">Previous points expired after inactivity.</p>}
                {card.points.rewards.length > 0 && <ul className="ocLoyaltyRewards">{card.points.rewards.map((reward) => <li key={reward.id}>
                  <span>{reward.label}</span><span>{number.format(reward.points)} points{card.points.active && card.points.balance >= reward.points ? " · Available" : ""}</span>
                </li>)}</ul>}
              </div>
              {card.programs.map((program) => <div className="ocLoyaltyBalance" key={program.id}>
                <h3>{program.name}</h3>
                <strong className="ocLoyaltyBalanceNumber">{number.format(program.rewardsAvailable)} <span>free {program.rewardsAvailable === 1 ? "pizza" : "pizzas"} available</span></strong>
                <p>{number.format(program.progress)} / {number.format(program.quantityRequired)} punches toward the next free pizza</p>
                <progress aria-label={`${program.name} progress`} value={program.progress} max={Math.max(1, program.quantityRequired)} />
                {program.units < 0 && <p className="ocLoyaltyNegative">Punch balance: {signed(program.units)}. New qualifying punches first cover this adjustment before progress toward another free pizza begins.</p>}
              </div>)}
              {card.programs.length === 0 && <p className="ocLoyaltyMuted">No active Jumbo card is available for this customer.</p>}
            </section>
            <section className="ocLoyaltySection" aria-label="This order's loyalty activity">
              <h3>This order · #{card.order.displayNumber}</h3>
              <p className="ocLoyaltyOrderChanges">Points change: <strong>{signed(pointsChange)}</strong>{[...punchChanges].map(([name, amount]) => <span key={name}>{name} change: <strong>{signed(amount)} {Math.abs(amount) === 1 ? "punch" : "punches"}</strong></span>)}</p>
              <Activity activity={card.thisOrder} emptyMessage="No points or Jumbo punches have been earned, used, or returned on this order." />
            </section>
            <section className="ocLoyaltySection" aria-label="Recent loyalty activity">
              <h3>Recent activity</h3>
              <Activity activity={card.history} emptyMessage="No recent loyalty activity." />
            </section>
          </>}
        </>}
      </div>}
    </dialog>
  </>;
}

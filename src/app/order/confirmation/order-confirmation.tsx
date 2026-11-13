"use client";

import { useEffect, useState } from "react";
import StreetMap, { type MapPoint } from "@/components/street-map";
import { CAR_COLORS, CAR_TYPES, carLabel, CURBSIDE_CHECK_IN_STATUSES } from "@/lib/curbside-arrival-policy";
import { orderPaymentState } from "@/lib/order-payment-state";
import "../order.css";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const clock = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

type Coordinates = { latitude: number; longitude: number };
type DeliveryTracker = {
  status: string;
  driverFirstName: string | null;
  pickedUpAt: string | null;
  enRouteAt: string | null;
  arrivedAt: string | null;
  deliveredAt: string | null;
  destination: Coordinates | null;
  etaMinutes: number | null;
  location: (Coordinates & { accuracyMeters: number | null; capturedAt: string; heading?: number | null }) | null;
};
type Payload = { order: any; delivery: DeliveryTracker | null; store: Coordinates | null; mapTileUrl: string | null; arrival?: { carColor: string; carType: string } | null };

const DELIVERY_STEPS = ["Order placed", "Making it", "Ready", "Out for delivery", "Delivered"];
const PICKUP_STEPS = ["Order placed", "Making it", "Ready for pickup", "Picked up"];
const isDelivery = (order: any) => order.service_type === "delivery" || order.service_type === "no_contact_delivery";

/** Curbside: tell the store you're outside and which car to look for. */
function CurbsideCheckIn({ orderId, initial }: { orderId: string; initial: { carColor: string; carType: string } | null }) {
  const [arrival, setArrival] = useState(initial);
  const [carColor, setCarColor] = useState(initial?.carColor || "");
  const [carType, setCarType] = useState(initial?.carType || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function checkIn() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/customer/orders/${encodeURIComponent(orderId)}/arrival`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carColor, carType }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not check you in.");
      setArrival({ carColor, carType });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check you in.");
    } finally {
      setBusy(false);
    }
  }
  if (arrival)
    return (
      <div className="curbsideCheckIn done" role="status">
        <strong>We know you&apos;re here!</strong>
        <span>We&apos;ll bring your order out to your {carLabel(arrival.carColor, arrival.carType)}.</span>
      </div>
    );
  return (
    <div className="curbsideCheckIn">
      <strong>Here for curbside pickup?</strong>
      <span>Tell us which car to look for and we&apos;ll bring it out.</span>
      <fieldset>
        <legend>Car color</legend>
        <div className="carChoices">
          {CAR_COLORS.map((color) => <button key={color} type="button" className="choiceButton" aria-pressed={carColor === color} onClick={() => setCarColor(color)}>{color}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>Type of car</legend>
        <div className="carChoices">
          {CAR_TYPES.map((type) => <button key={type} type="button" className="choiceButton" aria-pressed={carType === type} onClick={() => setCarType(type)}>{type}</button>)}
        </div>
      </fieldset>
      {error && <p className="orderError" role="alert">{error}</p>}
      <button type="button" className="reviewButton" disabled={busy || !carColor || !carType} onClick={() => void checkIn()}>
        {busy ? "Letting them know…" : !carColor ? "Choose your car color" : !carType ? "Choose your type of car" : "I'M HERE"}
      </button>
    </div>
  );
}

/** Which tracker step the order is on, Domino's-style. */
function currentStep(order: any, delivery: DeliveryTracker | null) {
  if (order.held_until_prep || order.waiting_for_open) return 0;
  const kitchen = ["sent_to_kitchen", "in_progress"].includes(order.status) ? 1 : 0;
  if (!isDelivery(order)) {
    if (order.status === "completed") return 3;
    if (order.status === "ready") return 2;
    return kitchen;
  }
  const status = delivery?.status || "";
  if (status === "DELIVERED") return 4;
  if (["PICKED_UP", "EN_ROUTE", "ARRIVED", "NO_CONTACT"].includes(status)) return 3;
  if (status === "READY_FOR_DRIVER" || ["ready", "completed"].includes(order.status)) return 2;
  return kitchen;
}

function headline(order: any, delivery: DeliveryTracker | null, step: number) {
  const driver = delivery?.driverFirstName || "Your driver";
  if (order.status === "draft") return order.payment_status === "paid"
    ? ["Your paid order needs a store check", "Your card was charged. The store still needs to send this order to the kitchen. Please don't pay again."]
    : ["Your order has not been placed", "Return to online ordering to finish checkout."];
  if (order.status === "cancelled") return ["Order cancelled", "Call Corner Deli if this is a surprise."];
  if (order.waiting_for_open) return ["Your order is queued for opening", "We'll start making it when the store opens."];
  if (order.held_until_prep) return ["Your order is scheduled", "We'll start making it closer to your scheduled time."];
  if (!isDelivery(order))
    return [
      ["We got your order", "It's in line for the kitchen."],
      ["We're making it", "Your order is on the line right now."],
      ["Ready for pickup", "Come on in. It's waiting for you at the counter."],
      ["Picked up", "Enjoy! Thanks for ordering from Corner Deli."],
    ][step];
  if (delivery?.status === "ARRIVED") return [`${driver} is outside`, "Your order is at your door."];
  if (delivery?.status === "NO_CONTACT") return [`${driver} is at your door`, "We couldn't reach you. Please check your door or call the deli."];
  if (delivery?.status === "PICKED_UP") return [`${driver} has your order`, "They're loading up and heading out shortly."];
  return [
    ["We got your order", "It's in line for the kitchen."],
    ["We're making it", "Fresh off the line in a few minutes."],
    ["Ready and waiting", "Your order is bagged and waiting for a driver."],
    [`${driver} is on the way`, delivery?.etaMinutes ? `About ${delivery.etaMinutes} min away.` : "Heading to you now."],
    ["Delivered", delivery?.deliveredAt ? `Dropped off at ${clock(delivery.deliveredAt)}. Enjoy!` : "Enjoy!"],
  ][step];
}

export default function OrderConfirmation({ orderId }: { orderId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!orderId) {
      setError("This confirmation link is incomplete.");
      return;
    }
    let active = true;
    let timer: number | undefined;
    async function load() {
      try {
        const response = await fetch(`/api/customer/orders/${encodeURIComponent(orderId)}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not load this order.");
        if (!active) return;
        setData(body);
        setError("");
        // Keep the tracker live until the order is finished.
        const done = ["completed", "cancelled"].includes(body.order.status) && (!isDelivery(body.order) || body.delivery?.status === "DELIVERED" || !body.delivery);
        const moving = ["EN_ROUTE", "ARRIVED"].includes(body.delivery?.status);
        if (!done && !(body.delivery?.status === "DELIVERED")) timer = window.setTimeout(load, moving ? 10_000 : 20_000);
      } catch (reason) {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Could not load this order.");
        timer = window.setTimeout(load, 30_000);
      }
    }
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [orderId]);

  if (error && !data)
    return (
      <main className="customerOrder confirmationPage">
        <section className="confirmationCard" aria-live="polite">
          <p className="eyebrow">Confirmation unavailable</p>
          <h1>{error}</h1>
          <a href="/order">Return to online ordering</a>
        </section>
      </main>
    );
  if (!data)
    return (
      <main className="customerOrder confirmationPage">
        <section className="confirmationCard" aria-live="polite">
          <h1>Confirming your order…</h1>
        </section>
      </main>
    );

  const { order, delivery } = data;
  const delivering = isDelivery(order);
  const steps = delivering ? DELIVERY_STEPS : PICKUP_STEPS;
  const step = currentStep(order, delivery);
  const [title, detail] = headline(order, delivery, step);
  const points: MapPoint[] = [];
  if (delivery?.location) {
    points.push({ id: "driver", kind: "driver", latitude: delivery.location.latitude, longitude: delivery.location.longitude, accuracyMeters: delivery.location.accuracyMeters, label: delivery.driverFirstName || "Driver", stale: Date.now() - new Date(delivery.location.capturedAt).getTime() > 3 * 60_000, heading: delivery.location.heading ?? null });
    if (delivery.destination) points.push({ id: "home", kind: "home", ...delivery.destination, label: "You" });
    if (data.store) points.push({ id: "store", kind: "store", ...data.store });
  }
  const refunded = Number(order.refunded_cents || 0);
  const payment = orderPaymentState({
    status: String(order.status),
    paymentStatus: String(order.payment_status),
    voided: Boolean(order.voided_at),
    paidCents: Number(order.paid_cents || 0),
    dueCents: Number(order.amount_due_cents ?? Math.max(0, order.total_cents - order.paid_cents)),
    refundedCents: refunded,
  });
  const due = payment.owes ? Number(order.amount_due_cents ?? Math.max(0, order.total_cents - order.paid_cents)) : 0;
  const hasRefund = ["refunded", "partially_refunded"].includes(payment.key)
    || (payment.key === "voided" && (refunded > 0 || ["refunded", "partially_refunded"].includes(order.payment_status)));
  const paymentLabel = due ? (delivering ? "Due at delivery" : "Due at pickup")
    : hasRefund ? (Number(order.paid_cents) > 0 ? "Partially refunded" : "Refunded")
    : payment.key === "voided" ? (Number(order.paid_cents) > 0 ? "Paid before cancellation" : "No payment due")
    : "Paid";
  const paymentAmount = due || (hasRefund ? refunded : Number(order.paid_cents || 0));

  return (
    <main className="customerOrder confirmationPage">
      <section className="confirmationCard orderTracker" aria-live="polite">
        <p className="eyebrow">Order #{order.display_number}</p>
        <h1>{title}</h1>
        <p className="trackerDetail">{detail}</p>
        {!["draft", "cancelled"].includes(order.status) && (
          <ol className="trackerSteps" style={{ ["--steps" as string]: steps.length }}>
            {steps.map((label, index) => (
              <li key={label} className={index < step ? "done" : index === step ? "now" : ""} aria-current={index === step ? "step" : undefined}>
                <i />
                <span>{label}</span>
              </li>
            ))}
          </ol>
        )}
        {points.length > 0 && (
          <div className="trackerMap">
            <StreetMap points={points} tileUrl={data.mapTileUrl} height={300} label={`${delivery?.driverFirstName || "Your driver"}'s approximate location`} />
            <small>Approximate location · updated {clock(delivery!.location!.capturedAt)}</small>
          </div>
        )}
        {order.service_type === "curbside" && !order.held_until_prep && !order.waiting_for_open && CURBSIDE_CHECK_IN_STATUSES.includes(order.status) && (
          <CurbsideCheckIn orderId={String(order.id)} initial={data.arrival || null} />
        )}
        <div className="confirmationTiming">
          <span>{delivering ? "Delivery" : order.service_type === "curbside" ? "Curbside pickup" : "Pickup"}</span>
          <strong>{order.timing_message_snapshot || (delivering ? "Delivery time confirmed" : "Pickup time confirmed")}</strong>
        </div>
        <p>
          {order.status === "cancelled" ? "This order has been cancelled." : <>Thanks, {order.first_name_snapshot}!{" "}
          {order.status === "draft"
            ? order.payment_status === "paid" ? "Your payment was approved. The store is checking your order and will start it shortly." : "Your order hasn't been sent yet."
            : order.payment_status === "paid" ? "Your payment was approved and your order was sent to Corner Deli." : "Your order was sent to Corner Deli."}</>}
        </p>
        <div className="confirmationLines">
          {order.lines.map((line: any, index: number) => (
            <div key={index}>
              <span>
                {line.quantity}× {line.variant_name ? `${line.variant_name} ` : ""}
                {line.name}
              </span>
              <strong>{money(line.line_total_cents)}</strong>
            </div>
          ))}
          {Number(order.discount_cents) > 0 && (
            <div>
              <span>Discount</span>
              <strong>−{money(Number(order.discount_cents))}</strong>
            </div>
          )}
          {Number(order.delivery_fee_cents) > 0 && !order.receipt?.untaxedFeeCents && (
            <div>
              <span>Delivery fee</span>
              <strong>{money(Number(order.delivery_fee_cents))}</strong>
            </div>
          )}
          {order.delivery_fee_waiver_label && (
            <div>
              <span>{order.delivery_fee_waiver_label}</span>
              <strong>{money(0)}</strong>
            </div>
          )}
          {(order.receipt_rows || []).map(([label, amount]: [string, string]) => (
            <div key={label} className={label.startsWith("Total") ? "confirmationTotal" : "confirmationTax"}>
              <span>{label}</span>
              <strong>{amount}</strong>
            </div>
          ))}
          <div className="confirmationDue">
            <span>{paymentLabel}</span>
            <strong>{money(paymentAmount)}</strong>
          </div>
        </div>
        <p className="confirmationEmail">
          {order.email_delivery_configured ? (
            <>
              A copy of these order details will be sent to <strong>{order.email_snapshot}</strong>. Keep this page open to follow your order.
            </>
          ) : (
            <>Keep this page open to follow your order. Email receipts are temporarily unavailable.</>
          )}
        </p>
        <a className="reviewButton confirmationButton" href="/order">
          Start another order
        </a>
      </section>
    </main>
  );
}

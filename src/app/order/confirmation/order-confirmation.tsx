"use client";

import { useEffect, useState } from "react";
import StreetMap, { type MapPoint } from "@/components/street-map";
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
  location: (Coordinates & { accuracyMeters: number | null; capturedAt: string }) | null;
};
type Payload = { order: any; delivery: DeliveryTracker | null; store: Coordinates | null; mapTileUrl: string | null };

const DELIVERY_STEPS = ["Order placed", "Making it", "Ready", "Out for delivery", "Delivered"];
const PICKUP_STEPS = ["Order placed", "Making it", "Ready for pickup", "Picked up"];
const isDelivery = (order: any) => order.service_type === "delivery" || order.service_type === "no_contact_delivery";

/** Which tracker step the order is on, Domino's-style. */
function currentStep(order: any, delivery: DeliveryTracker | null) {
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
  if (order.status === "cancelled") return ["Order cancelled", "Call Corner Deli if this is a surprise."];
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
    points.push({ id: "driver", kind: "driver", latitude: delivery.location.latitude, longitude: delivery.location.longitude, accuracyMeters: delivery.location.accuracyMeters, label: delivery.driverFirstName || "Driver", stale: Date.now() - new Date(delivery.location.capturedAt).getTime() > 3 * 60_000 });
    if (delivery.destination) points.push({ id: "home", kind: "home", ...delivery.destination, label: "You" });
    if (data.store) points.push({ id: "store", kind: "store", ...data.store });
  }
  const due = order.payment_status === "paid" ? 0 : Math.max(0, order.total_cents - order.paid_cents);

  return (
    <main className="customerOrder confirmationPage">
      <section className="confirmationCard orderTracker" aria-live="polite">
        <p className="eyebrow">Order #{order.display_number}</p>
        <h1>{title}</h1>
        <p className="trackerDetail">{detail}</p>
        {order.status !== "cancelled" && (
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
        <div className="confirmationTiming">
          <span>{delivering ? "Delivery" : order.service_type === "curbside" ? "Curbside pickup" : "Pickup"}</span>
          <strong>{order.timing_message_snapshot || (delivering ? "Delivery time confirmed" : "Pickup time confirmed")}</strong>
        </div>
        <p>
          Thanks, {order.first_name_snapshot}!{" "}
          {order.payment_status === "paid" ? "Your payment was approved and your order was sent to Corner Deli." : "Your order was sent to Corner Deli."}
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
          <div className="confirmationTotal">
            <span>{due ? (delivering ? "Due at delivery" : "Due at pickup") : "Total paid"}</span>
            <strong>{money(due || order.paid_cents || order.total_cents)}</strong>
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

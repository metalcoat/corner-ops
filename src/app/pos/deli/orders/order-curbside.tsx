"use client";

import { useState } from "react";
import { markDelivered, useCurbsideWaiting } from "../curbside-waiting";

/** On a curbside order: the car outside and "Delivered to car", while the customer is waiting. */
export default function OrderCurbside({ orderId, onDelivered }: { orderId: string; onDelivered: () => void }) {
  const { arrivals, reload } = useCurbsideWaiting();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const arrival = arrivals.find((entry) => entry.orderId === orderId);
  if (!arrival) return null;
  async function deliver() {
    if (!arrival) return;
    setBusy(true);
    const problem = await markDelivered(arrival);
    setError(problem);
    await reload();
    setBusy(false);
    if (!problem) onDelivered();
  }
  return <div className="ocCurbside" role="status">
    <strong>Customer is outside: {arrival.car}</strong>
    <button type="button" disabled={busy} onClick={() => void deliver()}>DELIVERED TO CAR</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

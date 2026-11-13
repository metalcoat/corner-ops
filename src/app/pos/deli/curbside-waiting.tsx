"use client";

import { useCallback, useEffect, useState } from "react";

export type CurbsideWaiting = { id: number; orderId: string; name: string; car: string; orderNumber: string; waitingMinutes: number };
const POLL_MS = 3000;

/** Curbside customers waiting outside right now (polls while mounted). */
export function useCurbsideWaiting() {
  const [arrivals, setArrivals] = useState<CurbsideWaiting[]>([]);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ordering/curbside", { cache: "no-store" });
      if (!response.ok) return;
      setArrivals(((await response.json()) as { arrivals?: CurbsideWaiting[] }).arrivals || []);
    } catch { /* Tries again next poll. */ }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), POLL_MS); return () => window.clearInterval(timer); }, [load]);
  return { arrivals, reload: load };
}

/** Records who brought it out; the store PC's curbside popup closes on its next poll. */
export async function markDelivered(arrival: CurbsideWaiting): Promise<string> {
  if (!window.confirm(`Order #${arrival.orderNumber} (${arrival.car}, ${arrival.name}) was brought out to the car?`)) return "";
  try {
    const response = await fetch("/api/ordering/curbside", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ arrivalId: arrival.id }) });
    const body = (await response.json()) as { error?: string };
    return response.ok || response.status === 409 ? "" : body.error || "Could not mark it delivered.";
  } catch {
    return "Could not reach the store server.";
  }
}

const waited = (minutes: number) => (minutes < 1 ? "just now" : `${minutes} min`);

/** A banner on every Deli POS screen, one line per car waiting outside. */
export default function CurbsideWaitingBanner() {
  const { arrivals, reload } = useCurbsideWaiting();
  const [busy, setBusy] = useState(0), [error, setError] = useState("");
  async function deliver(arrival: CurbsideWaiting) {
    setBusy(arrival.id);
    setError(await markDelivered(arrival));
    await reload();
    setBusy(0);
  }
  if (!arrivals.length) return null;
  return <>
    {arrivals.map((arrival) => <div className="deliOfflineBanner curbside" role="alert" key={arrival.id}>
      <strong>CURBSIDE WAITING · {arrival.car.toUpperCase()} · {arrival.name} · ORDER #{arrival.orderNumber} · {waited(arrival.waitingMinutes)}</strong>
      <button type="button" disabled={busy === arrival.id} onClick={() => void deliver(arrival)}>DELIVERED TO CAR</button>
    </div>)}
    {error && <div className="deliOfflineBanner offline" role="alert"><strong>{error}</strong><button type="button" onClick={() => setError("")}>OK</button></div>}
  </>;
}

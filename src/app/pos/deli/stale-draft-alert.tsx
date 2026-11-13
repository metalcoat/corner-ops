"use client";

import { useCallback, useEffect, useState } from "react";

type StaleDraft = { id: string; displayNumber: string; serviceType: string; totalCents: number; customer: string; items: string; startedBy: string; station: string; age: string };
const POLL_MS = 30000;
const money = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);

/** On the stations set in Settings → Operations: staff orders nobody sent. Stays until each is sent, deleted or snoozed. */
export default function StaleDraftAlert() {
  const [drafts, setDrafts] = useState<StaleDraft[]>([]), [busy, setBusy] = useState(""), [errors, setErrors] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const stationKey = localStorage.getItem("corner-ops-station-key") || "";
    if (!stationKey) return;
    const response = await fetch(`/api/ordering/stale-drafts?stationKey=${encodeURIComponent(stationKey)}`, { cache: "no-store" });
    if (!response.ok) return;
    setDrafts(((await response.json()) as { drafts?: StaleDraft[] }).drafts || []);
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), POLL_MS); return () => window.clearInterval(timer); }, [load]);

  async function act(draft: StaleDraft, url: string, body: Record<string, unknown>, fallback: string) {
    setBusy(draft.id); setErrors(current => ({ ...current, [draft.id]: "" }));
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), payload = await response.json();
      if (!response.ok) throw new Error(payload.error || fallback);
      await load();
      return true;
    } catch (error) {
      setErrors(current => ({ ...current, [draft.id]: error instanceof Error ? error.message : fallback }));
      return false;
    } finally { setBusy(""); }
  }
  const send = (draft: StaleDraft) => act(draft, `/api/ordering/orders/${draft.id}/submit`, { business: "Corner Deli" }, "Could not send it to the kitchen.");
  const snooze = (draft: StaleDraft) => act(draft, "/api/ordering/stale-drafts", { action: "snooze", orderId: draft.id }, "Could not snooze it.");
  function remove(draft: StaleDraft) {
    if (!window.confirm(`Delete draft order #${draft.displayNumber}? It is kept in the order history as voided.`)) return;
    void act(draft, `/api/ordering/order-center/${draft.id}/void`, { reason: "Draft never sent: deleted from the draft alert" }, "Could not delete it.");
  }
  async function open(draft: StaleDraft) {
    if (await snooze(draft)) window.location.assign(`/pos/deli/orders?orderId=${encodeURIComponent(draft.id)}`);
  }

  if (!drafts.length) return null;
  return <div className="staleDraftBackdrop" role="presentation"><section className="staleDraftDialog" role="alertdialog" aria-modal="true" aria-labelledby="stale-draft-title">
    <h2 id="stale-draft-title">{drafts.length === 1 ? "Draft order not sent" : `${drafts.length} draft orders not sent`}</h2>
    <p>Send to kitchen or delete?</p>
    {drafts.map(draft => <article key={draft.id}>
      <strong>#{draft.displayNumber}{draft.customer ? ` — ${draft.customer}` : ""} · {money(draft.totalCents)}</strong>
      <span>{draft.items}</span>
      <small>Started by {draft.startedBy}{draft.station ? ` on ${draft.station}` : ""} {draft.age}</small>
      {errors[draft.id] && <p role="alert">{errors[draft.id]}</p>}
      <div>
        <button type="button" className="send" disabled={busy === draft.id} onClick={() => void send(draft)}>SEND TO KITCHEN</button>
        <button type="button" className="delete" disabled={busy === draft.id} onClick={() => remove(draft)}>DELETE</button>
        <button type="button" disabled={busy === draft.id} onClick={() => void open(draft)}>OPEN ORDER</button>
        <button type="button" disabled={busy === draft.id} onClick={() => void snooze(draft)}>REMIND IN 5 MIN</button>
      </div>
    </article>)}
  </section></div>;
}

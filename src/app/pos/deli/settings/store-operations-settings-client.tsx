"use client";

import { useCallback, useEffect, useState } from "react";

type WindowRow = { id: string; service_type: string; weekday: number; opens_at: string; closes_at: string; ordering_opens_at: string | null; ordering_cutoff_at: string | null; active: boolean };
type Closure = { id: string; service_type: string; reason: string; customer_message: string; starts_at: string; ends_at: string | null };
type Operations = { timezone: string; weekly: WindowRow[]; emergency: Closure[] };
const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function StoreOperationsSettingsClient() {
  const [data, setData] = useState<Operations | null>(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ serviceType: "all", weekday: 1, opensAt: "09:00", closesAt: "21:30", orderingOpensAt: "", orderingCutoffAt: "" });
  const [closure, setClosure] = useState({ reason: "", customerMessage: "" });

  const load = useCallback(async () => {
    const response = await fetch("/api/ordering/settings/operations", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load Store Operations.");
    setData(payload);
  }, []);

  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, [load]);

  async function update(body: Record<string, unknown>) {
    setMessage("");
    const response = await fetch("/api/ordering/settings/operations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) return setMessage(payload.error || "Store Operations update failed.");
    await load();
    setMessage("Store Operations updated.");
  }

  if (!data) return <section className="posSettingsCard"><h2>Store Operations</h2><p role="status">{message || "Loading…"}</p></section>;
  return <section className="posSettingsCard">
    <p className="posDevEyebrow">Shared ordering rules · {data.timezone}</p>
    <h2>Store and ordering hours</h2>
    <p className="posSettingsHint">Ordering start and cutoff inherit the store interval when left blank. The closing minute is inclusive.</p>
    <div className="posTools">
      <select aria-label="Service" value={form.serviceType} onChange={(event) => setForm({ ...form, serviceType: event.target.value })}>{["all", "pickup", "delivery", "dine_in", "online", "phone"].map((value) => <option key={value} value={value}>{value === "all" ? "All services" : value.replace("_", " ")}</option>)}</select>
      <select aria-label="Weekday" value={form.weekday} onChange={(event) => setForm({ ...form, weekday: Number(event.target.value) })}>{dayNames.map((day, index) => <option key={day} value={index}>{day}</option>)}</select>
      <label><span>Open</span><input type="time" value={form.opensAt} onChange={(event) => setForm({ ...form, opensAt: event.target.value })} /></label>
      <label><span>Close</span><input type="time" value={form.closesAt} onChange={(event) => setForm({ ...form, closesAt: event.target.value })} /></label>
      <label><span>Ordering start (optional)</span><input type="time" value={form.orderingOpensAt} onChange={(event) => setForm({ ...form, orderingOpensAt: event.target.value })} /></label>
      <label><span>Ordering cutoff (optional)</span><input type="time" value={form.orderingCutoffAt} onChange={(event) => setForm({ ...form, orderingCutoffAt: event.target.value })} /></label>
      <button type="button" onClick={() => void update({ action: "upsert_weekly", ...form })}>Add interval</button>
    </div>
    <div className="posBandTable">
      {data.weekly.length ? data.weekly.map((row) => <div className="posBandRow" key={row.id}><span>{row.service_type === "all" ? "All" : row.service_type}</span><span>{dayNames[row.weekday]}</span><span>{row.opens_at.slice(0, 5)}–{row.closes_at.slice(0, 5)}</span><span>{row.ordering_opens_at ? `Orders ${row.ordering_opens_at.slice(0, 5)}–${row.ordering_cutoff_at?.slice(0, 5)}` : "Ordering inherits"}</span></div>) : <p className="posSettingsWarning">No hours are configured. Availability resolves as unconfigured and new enforcement will remain disabled until hours are saved.</p>}
    </div>
    <h2>Emergency status</h2>
    {data.emergency.map((item) => <div className="posSettingsWarning" key={item.id}><strong>EMERGENCY CLOSED · {item.service_type}</strong><p>{item.customer_message || item.reason}</p><button type="button" onClick={() => void update({ action: "reopen", id: item.id, reason: "Reopened from Store Operations" })}>Reopen now</button></div>)}
    {!data.emergency.length && <p className="posSettingsHint">No emergency closure is active.</p>}
    <label><span>Required internal reason</span><input value={closure.reason} onChange={(event) => setClosure({ ...closure, reason: event.target.value })} /></label>
    <label><span>Customer-facing message</span><input value={closure.customerMessage} onChange={(event) => setClosure({ ...closure, customerMessage: event.target.value })} /></label>
    <button type="button" disabled={!closure.reason.trim()} onClick={() => void update({ action: "emergency_close", serviceType: "all", ...closure })}>Emergency close now</button>
    {message && <p role="status">{message}</p>}
  </section>;
}

"use client";

import { useEffect, useState } from "react";

type Station = { key: string; name: string };

export default function StaleDraftSettingsClient() {
  const [minutes, setMinutes] = useState(""), [selected, setSelected] = useState<string[]>([]), [stations, setStations] = useState<Station[]>([]), [message, setMessage] = useState("");
  useEffect(() => {
    void fetch("/api/ordering/stale-drafts?settings=1", { cache: "no-store" }).then(response => response.json()).then(body => { if (!body.settings) throw new Error(body.error || "Could not load."); setMinutes(String(body.settings.minutes)); setSelected(body.settings.stations); setStations(body.stations); }).catch(error => setMessage(error.message));
  }, []);
  async function save() {
    setMessage("");
    const response = await fetch("/api/ordering/stale-drafts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ minutes: Number(minutes), stations: selected }) }), body = await response.json();
    setMessage(response.ok ? "Saved." : body.error || "Could not save.");
  }
  return <section className="posSettingsCard"><h2>Draft order alert</h2><p className="posSettingsHint">A staff order that was never sent to the kitchen pops up on these POS stations after sitting this long with nothing done to it. Online orders and AI calls are left out.</p>
    <label>Minutes before it pops up (0 = off)<input type="number" inputMode="numeric" min="0" max="240" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
    {stations.map(station => <label key={station.key}><input type="checkbox" checked={selected.includes(station.key)} onChange={event => setSelected(current => event.target.checked ? [...current, station.key] : current.filter(key => key !== station.key))} /> {station.name}</label>)}
    <div className="posTools"><button type="button" onClick={() => void save()}>SAVE DRAFT ALERT</button></div>
    {message && <p role="status" className="posSettingsHint">{message}</p>}
  </section>;
}

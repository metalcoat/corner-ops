"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import StreetMap, { type MapPoint } from "@/components/street-map";
import "./car-tablet.css";

type Step = { latitude: number; longitude: number; maneuver: string; instruction: string; street: string; metres: number };
type Place = { latitude: number; longitude: number; label: string };
type Preview = { from: Place; to: Place; reason?: string; route: null | { path: Array<[number, number]>; steps: Step[]; seconds: number; metres: number; stopSigns: number; preferredMetres: number; avoidMetres: number; streets: string[] } };

const metres = (a: [number, number], b: [number, number]) => {
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
/** Same wording as the tablet (Navigator.distanceText). */
const distanceText = (m: number) => { const feet = m * 3.28084; return feet < 950 ? `${Math.max(50, Math.round(feet / 50) * 50)} feet` : `${(m / 1609.34).toFixed(1)} miles`.replace("1.0 miles", "1 mile"); };
const SPEED_MPS = 11; // ~25 mph

/** POS Settings › Route tester: the car tablet's route and spoken directions for any address, with a simulated drive. */
export default function RouteTestClient() {
  const [to, setTo] = useState("");
  const [unit, setUnit] = useState("");
  const [from, setFrom] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);             // metres driven in the simulation
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [voice, setVoice] = useState(true);
  const [spoken, setSpoken] = useState<string[]>([]);
  const said = useRef(new Set<string>());

  const along = useMemo(() => {
    const path = preview?.route?.path ?? [];
    const out = [0]; for (let i = 1; i < path.length; i++) out.push(out[i - 1] + metres(path[i - 1], path[i]));
    return out;
  }, [preview]);
  const stepAlong = useMemo(() => (preview?.route?.steps ?? []).map((step) => {
    const path = preview!.route!.path; let best = 0, bestDistance = Infinity;
    path.forEach((point, i) => { const d = metres(point, [step.latitude, step.longitude]); if (d < bestDistance) { bestDistance = d; best = i; } });
    return along[best] ?? 0;
  }), [preview, along]);
  const total = along.at(-1) ?? 0;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setDone((value) => { const next = Math.min(total, value + SPEED_MPS * speed * 0.25); if (next >= total) setRunning(false); return next; }), 250);
    return () => window.clearInterval(timer);
  }, [running, speed, total]);

  // What the tablet would say at this point (same thresholds as the app: 300 m early, 45 m at the turn).
  const steps = preview?.route?.steps ?? [];
  const next = stepAlong.findIndex((value) => value > done + 5);
  const nextIndex = next < 0 ? steps.length - 1 : next;
  const toNext = Math.max(0, (stepAlong[nextIndex] ?? total) - done);
  useEffect(() => {
    const step = steps[nextIndex];
    if (!running || !step) return;
    const phase = total - done < 30 ? "arrive" : toNext < 45 ? "near" : toNext < 300 ? "far" : null;
    if (!phase) return;
    const key = `${nextIndex}:${phase === "far" ? "far" : "near"}`;
    if (said.current.has(key) || (phase === "far" && said.current.has(`${nextIndex}:near`))) return;
    said.current.add(key);
    const text = phase === "far" ? `In ${distanceText(toNext)}, ${step.instruction.charAt(0).toLowerCase()}${step.instruction.slice(1)}` : step.instruction;
    setSpoken((list) => [text, ...list].slice(0, 12));
    if (voice && "speechSynthesis" in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }
  }, [done, running, nextIndex, toNext, total, steps, voice]);

  const car = useMemo<[number, number] | null>(() => {
    const path = preview?.route?.path; if (!path?.length) return null;
    const i = Math.max(0, along.findIndex((value) => value >= done) - 1);
    const span = (along[i + 1] ?? along[i]) - along[i], t = span ? (done - along[i]) / span : 0;
    const a = path[i], b = path[i + 1] ?? a;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }, [preview, along, done]);

  async function plan(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(""); setRunning(false); setDone(0); setSpoken([]); said.current.clear();
    try {
      const response = await fetch("/api/ordering/car-tablets/route-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, unit, from }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Couldn't plan that route.");
      setPreview(payload);
      if (!payload.route) setMessage(payload.reason || "No route.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't plan that route.");
    } finally { setBusy(false); }
  }

  const points: MapPoint[] = preview ? [
    { id: "from", kind: "store", latitude: preview.from.latitude, longitude: preview.from.longitude, label: "Start" },
    { id: "to", kind: "home", latitude: preview.to.latitude, longitude: preview.to.longitude, label: "Delivery" },
    ...(car && (running || done > 0) ? [{ id: "car", kind: "driver" as const, latitude: car[0], longitude: car[1], label: "Car" }] : []),
  ] : [];
  const route = preview?.route;
  const feet = (m: number) => `${Math.round(m * 3.28084).toLocaleString()} ft`;

  return <section className="posSettingsCard carTabletSettings">
    <p className="posDevEyebrow">Delivery car</p>
    <h2>Route tester</h2>
    <p className="posSettingsHint">The route and spoken directions the car tablet gives for an address: on Jay, Greene and Lafayette where it can, never down an avoid street (Knox, Montgomery) except the last block to a house on it. Stop signs and street marks come from the Ogdensburg stop sign map.</p>
    <form className="posTools carPairNew" onSubmit={plan}>
      <label><span>Drive to (address)</span><input id="rt-to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="e.g. 1015 Knox St, Ogdensburg" /></label>
      <label><span>Apt / unit</span><input id="rt-unit" value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="e.g. 153" style={{ width: 110 }} /></label>
      <label><span>From (blank = the deli)</span><input id="rt-from" value={from} onChange={(event) => setFrom(event.target.value)} placeholder="Corner Deli" /></label>
      <button disabled={busy || to.trim().length < 5}>{busy ? "Planning…" : "Plan route"}</button>
    </form>
    {message && <p role="status">{message}</p>}
    {preview && <>
      <p><b>{preview.from.label}</b> → <b>{preview.to.label}</b></p>
      {route && <p>{distanceText(route.metres)} · about {Math.max(1, Math.round(route.seconds / 60))} min · {route.stopSigns} stop sign{route.stopSigns === 1 ? "" : "s"} · {feet(route.preferredMetres)} on preferred streets{route.avoidMetres ? ` · ${feet(route.avoidMetres)} on avoid streets (last stretch)` : " · no avoid streets"}</p>}
      <StreetMap points={points} lines={route ? [{ id: "route", points: route.path }] : []} height={460} label="Planned route" />
      {route && <>
        <div className="posTools" style={{ margin: "10px 0" }}>
          <button type="button" onClick={() => { if (done >= total) { setDone(0); said.current.clear(); setSpoken([]); } setRunning(!running); }}>{running ? "Pause" : done > 0 && done < total ? "Resume" : "Simulate drive"}</button>
          <button type="button" onClick={() => { setRunning(false); setDone(0); said.current.clear(); setSpoken([]); }}>Restart</button>
          <label><span>Speed</span><select id="rt-speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value={1}>Real time</option><option value={4}>4×</option><option value={10}>10×</option></select></label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input id="rt-voice" type="checkbox" checked={voice} onChange={(event) => setVoice(event.target.checked)} /> <span>Speak directions</span></label>
        </div>
        {(running || done > 0) && <article><strong>{done >= total - 30 ? "You have arrived" : `${distanceText(toNext)} · ${steps[nextIndex]?.instruction ?? ""}`}</strong><br /><small>{distanceText(Math.max(0, total - done))} to go</small></article>}
        <h3>Turn by turn</h3>
        <ol>{route.steps.map((step, i) => <li key={i} style={{ fontWeight: i === nextIndex && (running || done > 0) ? 800 : 400 }}>{step.instruction}{step.metres ? ` · ${distanceText(step.metres)}` : ""}</li>)}</ol>
        {spoken.length > 0 && <><h3>Said so far</h3><ul>{spoken.map((line, i) => <li key={i}><span>{line}</span></li>)}</ul></>}
      </>}
    </>}
  </section>;
}

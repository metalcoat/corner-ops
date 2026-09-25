"use client";

import { responseMessage } from "@/app/client-http";
import { forgetPunch, readPendingPunch, rememberPunch } from "@/app/timeclock-pending";
import { isPunchReceipt, type PunchCommand } from "@/lib/timeclock-contract";
import { FormEvent, useEffect, useRef, useState } from "react";
import "./clock.css";

type Identity = { employeeId: string; employee: string; entryId: string | null; clockedIn: boolean };
type Position = { latitude: number | null; longitude: number | null; accuracy: number | null; status: string };
type ScheduledShift = { id: string; position: string; startsAt: string; endsAt: string; instructions: string };
const unavailable: Position = { latitude: null, longitude: null, accuracy: null, status: "Location unavailable; the punch will be flagged for review." };
const deadline = (ms = 15000) => AbortSignal.timeout(ms);
async function logout() { await fetch("/api/employee/session", { method: "DELETE", signal: deadline(3000) }).catch(() => undefined); }
async function capturePosition(): Promise<Position> {
  if (!navigator.geolocation) return unavailable;
  return new Promise((resolve) => {
    // The permission prompt itself can outlive the geolocation API's timeout.
    const timer = window.setTimeout(() => resolve(unavailable), 6000);
    navigator.geolocation.getCurrentPosition(
      (result) => { window.clearTimeout(timer); resolve({ latitude: result.coords.latitude, longitude: result.coords.longitude,
        accuracy: result.coords.accuracy, status: `Location captured within about ${Math.round(result.coords.accuracy)} meters.` }); },
      () => { window.clearTimeout(timer); resolve(unavailable); },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 },
    );
  });
}

export default function TikiClockPage() {
  const [pin, setPin] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [pending, setPending] = useState<PunchCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const lastInteraction = useRef(Date.now());
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"good" | "bad" | "">("");
  const [criticalAlert, setCriticalAlert] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<ScheduledShift | null>(null);
  const [position, setPosition] = useState<Position>(unavailable);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!identity) return;
    const timer = window.setInterval(() => {
      if (!locked.current && Date.now() - lastInteraction.current > 120000) {
        setIdentity(null); setPending(null); void logout();
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [identity]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true; setBusy(true); setCriticalAlert(null); setMessage(""); setInstructions(null);
    try {
      const login = await fetch("/api/employee/session", { method: "POST", signal: deadline(),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ business: "Tiki", pin }) });
      if (!login.ok) throw new Error(await responseMessage(login, "PIN not recognized."));
      const response = await fetch("/api/timeclock", { cache: "no-store", signal: deadline() });
      if (!response.ok) throw new Error(await responseMessage(response, "Could not check your clock status."));
      const state = await response.json() as Identity;
      if (!state.employeeId || !state.employee || typeof state.clockedIn !== "boolean") throw new Error("Clock status was not confirmed. No punch was submitted.");
      // Recover the SAME request after a lost response or a page reload.
      setPending(readPendingPunch(sessionStorage, state.employeeId));
      setIdentity(state); setPin(""); lastInteraction.current = Date.now();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed. No punch was submitted.");
      setTone("bad"); await logout();
    } finally { locked.current = false; setBusy(false); }
  }

  async function punch() {
    if (!identity || locked.current) return;
    locked.current = true; setBusy(true); setCriticalAlert(null); lastInteraction.current = Date.now();
    const command: PunchCommand = pending || { requestId: crypto.randomUUID(),
      action: identity.clockedIn ? "clock-out" : "clock-in", entryId: identity.entryId };
    try {
      // Persist before the network request. Storage failure must not create an
      // unrepeatable punch; retrying this record is safe even after a reload.
      rememberPunch(sessionStorage, identity.employeeId, command); setPending(command);
      const location = await capturePosition(); setPosition(location);
      const response = await fetch("/api/timeclock", { method: "POST", signal: deadline(),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...command, ...location }) });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        if (payload.code === "PUNCH_STATE_CHANGED" || payload.code === "PUNCH_CLIENT_OUTDATED") {
          // The server explicitly rejected this command without writing a punch.
          forgetPunch(sessionStorage, identity.employeeId); setPending(null); setIdentity(null);
          await logout();
          setMessage(String(payload.error || "Clock status changed. Sign in again before recording a punch.")); setTone("bad");
          return;
        }
        throw new Error(String(payload.error || "The server could not confirm the punch."));
      }
      if (!isPunchReceipt(payload, command)) throw new Error("The server returned an incomplete punch confirmation.");
      try { forgetPunch(sessionStorage, identity.employeeId); } catch { /* A replay remains safe if local cleanup fails. */ }
      const action = payload.action === "clocked-out" ? "clocked out" : "clocked in";
      setMessage(`${payload.employee} ${action} successfully.${payload.replayed ? " The original punch was confirmed; no new punch was created." : ""}${payload.locationReview ? " Location flagged for manager review." : ""}`);
      setTone("good"); setIdentity(null); setPending(null);
      setInstructions((payload as unknown as { scheduledShift?: ScheduledShift }).scheduledShift || null);
      await logout();
    } catch (error) {
      setCriticalAlert(`${error instanceof Error ? error.message : "Contact with the clock was lost."} Use Retry same punch to check the original request. Do not keep pressing the button. Note the time and tell a manager if it remains unconfirmed.`);
    } finally { locked.current = false; setBusy(false); }
  }

  async function reset() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { await logout(); setIdentity(null); setPending(null); setPin(""); setCriticalAlert(null); }
    finally { locked.current = false; setBusy(false); }
  }

  return <main className="clockPage"><section className="clockCard">
    <div className="clockBrand"><p className="eyebrow">Tiki employee clock</p>
      <h1>{now ? new Intl.DateTimeFormat("en-US", { timeStyle: "medium" }).format(now) : "Time clock"}</h1>
      <p>{now ? new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(now) : ""}</p>
    </div>
    {!identity ? <form onSubmit={signIn}>
      <label className="pinLabel">Five-digit PIN<input className="pinDisplay" type="password" inputMode="numeric" pattern="\d{5}" maxLength={5}
        value={pin} disabled={busy} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 5))}
        autoComplete="off" aria-label="Five-digit employee PIN" /></label>
      <div className="keypad" aria-label="PIN keypad">{[1,2,3,4,5,6,7,8,9].map((digit) =>
        <button type="button" disabled={busy} key={digit} onClick={() => setPin((value) => `${value}${digit}`.slice(0,5))}>{digit}</button>)}
        <button type="button" disabled={busy} onClick={() => setPin("")}>Clear</button>
        <button type="button" disabled={busy} onClick={() => setPin((value) => `${value}0`.slice(0,5))}>0</button>
        <button type="button" disabled={busy} onClick={() => setPin((value) => value.slice(0,-1))}>⌫</button>
      </div>
      <button className="primary clockSubmit" disabled={busy || pin.length !== 5}>{busy ? "Checking…" : "Check clock status"}</button>
    </form> : <div>
      <h2>{identity.employee}</h2><p>{identity.clockedIn ? "You are currently clocked in." : "You are currently clocked out."}</p>
      {pending && <p>An earlier punch needs confirmation. Retrying will check that same punch, not toggle your status.</p>}
      <button type="button" className="primary clockSubmit" disabled={busy} onClick={() => void punch()}>
        {busy ? "Recording…" : pending ? "Retry same punch" : identity.clockedIn ? "Confirm clock out" : "Confirm clock in"}
      </button>
      <button type="button" disabled={busy} onClick={() => void reset()}>Different employee / Cancel</button>
    </div>}
    <p className="locationStatus">{position.status}</p>
    {criticalAlert && <div className="clockCriticalAlert" role="alert" aria-live="assertive"><strong>PUNCH NOT CONFIRMED</strong><span>{criticalAlert}</span></div>}
    {message && <div className={`clockMessage ${tone}`} role="status">{message}</div>}
    {instructions && <section className="clockInstructions" aria-live="polite"><p className="eyebrow">Instructions for this shift</p>
      <strong>{instructions.position || "Scheduled shift"}</strong><p>{instructions.instructions || "No additional instructions were added."}</p></section>}
    <a className="clockAdminLink" href="/">Owner sign-in</a>
  </section></main>;
}

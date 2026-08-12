"use client";

import { useEffect, useRef, useState } from "react";
import "./pos-pin-gate.css";

export type PosEmployeeSession = {
  employeeId: string;
  business: "Corner Deli";
  name: string;
  position: string;
  clockInRequired: boolean;
  issuedAt: number;
  expiresAt: number;
};

export type PosSessionView = { authenticated: boolean; session?: PosEmployeeSession };

export default function PosPinGate({ onAuthenticated }: { onAuthenticated: (session: PosEmployeeSession) => void }) {
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState<PosEmployeeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  async function submit(value: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pos/session", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: value }),
      });
      const payload = await response.json() as { session?: PosEmployeeSession; error?: string };
      if (!response.ok || !payload.session) throw new Error(payload.error || "PIN login failed.");
      if (payload.session.clockInRequired) setPending(payload.session);
      else onAuthenticated(payload.session);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "PIN login failed.");
    } finally {
      setPin("");
      setBusy(false);
      submitting.current = false;
    }
  }

  function digit(value: string) {
    if (busy || pending || pin.length >= 4) return;
    const next = `${pin}${value}`;
    setPin(next);
  }

  useEffect(() => {
    if (pin.length === 4) void submit(pin);
    // submit is intentionally driven only when the digit count reaches four.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  async function clockIn() {
    if (busy || !pending) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pos/clock-in", { method: "POST" });
      const payload = await response.json() as { session?: PosEmployeeSession; error?: string };
      if (!response.ok || !payload.session) throw new Error(payload.error || "Clock-in failed.");
      onAuthenticated(payload.session);
    } catch (clockError) {
      setError(clockError instanceof Error ? clockError.message : "Clock-in failed.");
    } finally { setBusy(false); }
  }

  async function cancel() {
    await fetch("/api/pos/session", { method: "DELETE" });
    setPending(null);
    setPin("");
    setError("");
  }

  if (pending) return <main className="posPinPage">
    <section className="posClockPrompt" aria-label="Clock in required">
      <span>CORNER DELI</span>
      <h1>Hi, {pending.name.split(/\s+/)[0]}</h1>
      <p>You&apos;re not clocked in.</p>
      <strong>Clock in now?</strong>
      {error ? <div role="alert">{error}</div> : null}
      <button type="button" className="clockIn" disabled={busy} onClick={() => void clockIn()}>{busy ? "CLOCKING IN…" : "CLOCK IN & CONTINUE"}</button>
      <button type="button" disabled={busy} onClick={() => void cancel()}>CANCEL</button>
    </section>
  </main>;

  return <main className="posPinPage">
    <section className="posPinPanel" aria-label="Corner Deli employee PIN login">
      <span>EMPLOYEE POS</span><h1>CORNER DELI</h1><p>Enter your four-digit PIN</p>
      <div className="posPinDots" aria-label={`${pin.length} of 4 PIN digits entered`}>{[0, 1, 2, 3].map((index) => <i className={index < pin.length ? "filled" : ""} key={index} />)}</div>
      {error ? <div className="posPinError" role="alert">{error}</div> : <div className="posPinError placeholder" />}
      <div className="posKeypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((value) => <button type="button" key={value} disabled={busy} onClick={() => digit(value)}>{value}</button>)}
        <button type="button" aria-label="Backspace" disabled={busy || !pin} onClick={() => setPin((value) => value.slice(0, -1))}>←</button>
        <button type="button" disabled={busy} onClick={() => digit("0")}>0</button>
        <button type="button" className="clear" disabled={busy || !pin} onClick={() => setPin("")}>Clear</button>
      </div>
    </section>
  </main>;
}

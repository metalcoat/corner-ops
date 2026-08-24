"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useState } from "react";
import "./clock.css";

type Position = {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  status: string;
};

type ScheduledShift = {
  id: string;
  position: string;
  startsAt: string;
  endsAt: string;
  instructions: string;
};


export default function TikiClockPage() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [instructions, setInstructions] = useState<ScheduledShift | null>(null);
  const [tone, setTone] = useState<"good" | "bad" | "">("");
  const [now, setNow] = useState(new Date());
  const [position, setPosition] = useState<Position>({
    latitude: null,
    longitude: null,
    accuracy: null,
    status: "Requesting location…",
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    if (!navigator.geolocation) {
      setPosition((current) => ({ ...current, status: "Location is unavailable on this device." }));
    } else {
      navigator.geolocation.getCurrentPosition(
        (result) => setPosition({
          latitude: result.coords.latitude,
          longitude: result.coords.longitude,
          accuracy: result.coords.accuracy,
          status: `Location captured within about ${Math.round(result.coords.accuracy)} meters.`,
        }),
        () => setPosition((current) => ({
          ...current,
          status: "Location permission was not granted. The punch can still be submitted and will be flagged for review.",
        })),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      );
    }
    return () => window.clearInterval(timer);
  }, []);

  async function punch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setInstructions(null);
    setTone("");
    let authenticated = false;
    try {
      const login = await fetch("/api/employee/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business: "Tiki", pin }),
      });
      if (!login.ok) throw new Error(await responseMessage(login, "PIN not recognized."));
      authenticated = true;

      const response = await fetch("/api/timeclock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: position.latitude,
          longitude: position.longitude,
          accuracy: position.accuracy,
        }),
      });
      const payload = await response.json() as {
        error?: string;
        action?: "clocked-in" | "clocked-out";
        employee?: string;
        locationReview?: string | null;
        scheduledShift?: ScheduledShift | null;
      };
      if (!response.ok) throw new Error(payload.error || "Punch failed.");
      const action = payload.action === "clocked-out" ? "clocked out" : "clocked in";
      setMessage(`${payload.employee} ${action} successfully.${payload.locationReview ? " Location flagged for manager review." : ""}`);
      setInstructions(payload.action === "clocked-in" ? payload.scheduledShift || null : null);
      setTone("good");
      setPin("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Punch failed.");
      setTone("bad");
    } finally {
      if (authenticated) {
        await fetch("/api/employee/session", { method: "DELETE" }).catch(() => undefined);
      }
      setBusy(false);
    }
  }

  function addDigit(digit: string) {
    if (pin.length < 5) setPin((current) => `${current}${digit}`);
  }

  return (
    <main className="clockPage">
      <section className="clockCard">
        <div className="clockBrand">
          <p className="eyebrow">Tiki employee clock</p>
          <h1>{new Intl.DateTimeFormat("en-US", { timeStyle: "medium" }).format(now)}</h1>
          <p>{new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(now)}</p>
        </div>

        <form onSubmit={punch}>
          <label className="pinLabel">
            Five-digit PIN
            <input
              className="pinDisplay"
              type="password"
              inputMode="numeric"
              pattern="\d{5}"
              maxLength={5}
              value={pin}
              onChange={(event: { target: { value: string } }) => setPin(event.target.value.replace(/\D/g, "").slice(0, 5))}
              autoComplete="off"
              aria-label="Five-digit employee PIN"
            />
          </label>

          <div className="keypad" aria-label="PIN keypad">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
              <button type="button" key={digit} onClick={() => addDigit(String(digit))}>{digit}</button>
            ))}
            <button type="button" onClick={() => setPin("")}>Clear</button>
            <button type="button" onClick={() => addDigit("0")}>0</button>
            <button type="button" onClick={() => setPin((current) => current.slice(0, -1))}>⌫</button>
          </div>

          <button className="primary clockSubmit" disabled={busy || pin.length !== 5}>
            {busy ? "Recording…" : "Clock in / out"}
          </button>
        </form>

        <p className="locationStatus">{position.status}</p>
        {message && <div className={`clockMessage ${tone}`}>{message}</div>}
        {instructions && <section className="clockInstructions" aria-live="polite">
          <p className="eyebrow">Instructions for this shift</p>
          <strong>{instructions.position || "Scheduled shift"}</strong>
          <span>{new Date(instructions.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – {new Date(instructions.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          {instructions.instructions ? <p>{instructions.instructions}</p> : <p>No additional instructions were added.</p>}
        </section>}
        <a className="clockAdminLink" href="/">Owner sign-in</a>
      </section>
    </main>
  );
}

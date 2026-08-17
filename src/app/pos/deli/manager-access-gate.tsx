"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ManagerAccessGate({ denied = false }: { denied?: boolean }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pos/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const payload = await response.json() as { session?: { posRole?: string; clockInRequired?: boolean }; error?: string };
      if (!response.ok || !payload.session) throw new Error(payload.error || "Manager unlock failed.");
      if (payload.session.posRole !== "manager" && payload.session.posRole !== "owner") {
        window.dispatchEvent(new CustomEvent("corner-ops-pos-authenticated", { detail: payload.session }));
        router.refresh();
        return;
      }
      if (payload.session.clockInRequired) {
        const clockResponse = await fetch("/api/pos/clock-in", { method: "POST" });
        const clockPayload = await clockResponse.json() as { error?: string };
        if (!clockResponse.ok) throw new Error(clockPayload.error || "Clock-in is required before continuing.");
      }
      window.dispatchEvent(new CustomEvent("corner-ops-pos-authenticated", { detail: payload.session }));
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Manager unlock failed.");
    } finally {
      setPin("");
      setBusy(false);
    }
  }

  return <main className="managerAccessPage">
    <section className="managerAccessPanel" aria-label={denied ? "Manager access required" : "Manager authorization required"}>
      <span>CORNER DELI POS</span>
      <h1>{denied ? "MANAGER ACCESS REQUIRED" : "MANAGER AUTHORIZATION REQUIRED"}</h1>
      {denied ? <p>Your signed-in employee role cannot access configuration or reports.</p> : <form onSubmit={unlock}>
        <label>Enter PIN<input autoFocus type="password" inputMode="numeric" autoComplete="off" minLength={4} maxLength={4} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || pin.length !== 4}>{busy ? "UNLOCKING…" : "UNLOCK"}</button>
      </form>}
      <Link href="/pos/deli">BACK TO POS</Link>
    </section>
  </main>;
}

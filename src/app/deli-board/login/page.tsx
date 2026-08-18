"use client";

import { FormEvent, useState } from "react";
import "../wallboard.css";

export default function DeliBoardLoginPage() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/employee/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business: "Corner Deli", pin }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "PIN not recognized.");
      }
      window.location.href = "/deli-board";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
      setBusy(false);
    }
  }

  return <main className="deliBoard signedOut">
    <section style={{ width: "min(92vw, 480px)" }}>
      <div className="boardBrand" style={{ justifyContent: "center", marginBottom: 22 }}><span className="boardDot" /><div><strong>Corner Deli</strong><small>Display access</small></div></div>
      <h1>Deli Board</h1>
      <p>Enter a Corner Deli employee PIN to activate this display. This uses the restricted employee session, not the owner account.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12, marginTop: 22 }}>
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          placeholder="Employee PIN"
          aria-label="Employee PIN"
          style={{ fontSize: "1.4rem", textAlign: "center", letterSpacing: ".15em", borderRadius: 10, border: "1px solid #30445f", background: "#07111f", color: "#f8fafc", padding: "14px 16px" }}
        />
        <button disabled={busy || !pin} style={{ border: 0, borderRadius: 10, padding: "13px 16px", fontSize: "1rem", fontWeight: 900, background: "#f59e0b", color: "#111827", cursor: "pointer" }}>{busy ? "Opening board…" : "Open Deli Board"}</button>
      </form>
      {error && <p style={{ color: "#fca5a5", marginTop: 14 }}>{error}</p>}
    </section>
  </main>;
}

"use client";

import { FormEvent, useState } from "react";
import "../wallboard.css";

const DISPLAY_TOKEN_KEY = "corner_ops_deli_board_token";

export default function DeliBoardLoginPage() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/deli-board/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; token?: string } | null;
      if (!response.ok || !payload?.token) {
        throw new Error(payload?.error || "PIN not recognized.");
      }

      window.localStorage.setItem(DISPLAY_TOKEN_KEY, payload.token);

      const verify = await fetch("/api/deli-board", {
        cache: "no-store",
        headers: { Authorization: `Bearer ${payload.token}` },
      });
      if (!verify.ok) {
        window.localStorage.removeItem(DISPLAY_TOKEN_KEY);
        throw new Error("PIN was accepted, but the display session could not be activated.");
      }

      window.location.replace("/deli-board");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
      setBusy(false);
    }
  }

  const validLength = pin.length === 4 || pin.length === 5;

  return <main className="deliBoard signedOut">
    <section style={{ width: "min(92vw, 480px)" }}>
      <div className="boardBrand" style={{ justifyContent: "center", marginBottom: 22 }}><span className="boardDot" /><div><strong>Corner Deli</strong><small>Display access</small></div></div>
      <h1>Deli Board</h1>
      <p>Enter a 4- or 5-digit Corner Deli employee PIN to activate this display. The resulting display token is limited to the Deli Board and does not unlock owner tools.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12, marginTop: 22 }}>
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 5))}
          inputMode="numeric"
          pattern="\d{4,5}"
          minLength={4}
          maxLength={5}
          autoComplete="off"
          autoFocus
          placeholder="4- or 5-digit employee PIN"
          aria-label="Four- or five-digit employee PIN"
          style={{ fontSize: "1.4rem", textAlign: "center", letterSpacing: ".15em", borderRadius: 10, border: "1px solid #30445f", background: "#07111f", color: "#f8fafc", padding: "14px 16px" }}
        />
        <button disabled={busy || !validLength} style={{ border: 0, borderRadius: 10, padding: "13px 16px", fontSize: "1rem", fontWeight: 900, background: "#f59e0b", color: "#111827", cursor: "pointer" }}>{busy ? "Opening board…" : "Open Deli Board"}</button>
      </form>
      {error && <p style={{ color: "#fca5a5", marginTop: 14 }}>{error}</p>}
    </section>
  </main>;
}

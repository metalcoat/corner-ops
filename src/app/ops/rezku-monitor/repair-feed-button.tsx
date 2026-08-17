"use client";

import { useState } from "react";

export default function RepairRezkuFeedButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function repair() {
    setBusy(true);
    setMessage("Checking Resend and replaying any missing Rezku deliveries…");
    try {
      const response = await fetch("/api/rezku-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair-feed" }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string;
        webhookReenabled?: boolean;
        missingFound?: number;
        recovered?: Array<{ processed?: boolean; reports?: number; failures?: number }>;
      } | null;
      if (!response.ok) throw new Error(payload?.error || `Repair failed (${response.status}).`);

      const recovered = payload?.recovered || [];
      const reports = recovered.reduce((total, item) => total + Number(item.reports || 0), 0);
      const failures = recovered.reduce((total, item) => total + Number(item.failures || 0), 0);
      const missing = Number(payload?.missingFound || 0);
      const webhook = payload?.webhookReenabled ? " Resend webhook was re-enabled." : "";
      setMessage(failures
        ? `Recovered ${missing} missing email${missing === 1 ? "" : "s"} and ${reports} workbook${reports === 1 ? "" : "s"}, with ${failures} workbook failure${failures === 1 ? "" : "s"}.${webhook}`
        : `Recovered ${missing} missing Rezku email${missing === 1 ? "" : "s"} and ${reports} workbook${reports === 1 ? "" : "s"}.${webhook}`);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rezku feed repair failed.");
    } finally {
      setBusy(false);
    }
  }

  return <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", margin: "0 0 14px" }}>
    <button className="primary" disabled={busy} onClick={() => void repair()}>{busy ? "Repairing Rezku feed…" : "Repair Rezku feed"}</button>
    {message && <span>{message}</span>}
  </div>;
}

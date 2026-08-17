"use client";

import { useState } from "react";
import "../control-center.css";

type RepairResult = {
  webhookId?: string;
  webhookReenabled?: boolean;
  receivedRezkuEmails?: number;
  alreadyProcessed?: number;
  missingFound?: number;
  recovered?: Array<{
    emailId: string;
    createdAt: string | null;
    statusCode: number;
    processed: boolean;
    reports: number;
    failures: number;
  }>;
  error?: string;
};

export default function RezkuRepairPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RepairResult | null>(null);
  const [error, setError] = useState("");

  async function repair() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/rezku-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair-feed" }),
      });
      const payload = await response.json().catch(() => ({})) as RepairResult;
      if (!response.ok) throw new Error(payload.error || `Repair failed (${response.status}).`);
      setResult(payload);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  const recovered = result?.recovered || [];
  const failures = recovered.reduce((total, row) => total + Number(row.failures || 0), 0);

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Rezku recovery</p>
        <h1>Repair Rezku feed</h1>
        <p>Re-enable the Resend inbound webhook and replay any trusted Rezku daily-report emails that Corner Ops missed.</p>
      </div>
      <div className="controlActions">
        <a href="/ops/rezku-monitor">Rezku Monitor</a>
        <a href="/ops/payroll-control">Payroll Control</a>
      </div>
    </header>

    {error && <div className="noticeBar">{error}</div>}

    <section className="controlCard">
      <h2>Automatic recovery</h2>
      <p>This compares Resend's received Rezku emails with the Corner Ops import ledger, turns the webhook back on if needed, and imports only missing emails.</p>
      <button className="primary" disabled={busy} onClick={() => void repair()}>
        {busy ? "Repairing Rezku feed…" : "Repair Rezku feed now"}
      </button>
    </section>

    {result && <section className="controlCard">
      <h2>Recovery result</h2>
      <p><strong>Webhook:</strong> {result.webhookReenabled ? "Re-enabled" : "Already enabled"}</p>
      <p><strong>Rezku emails found in Resend:</strong> {result.receivedRezkuEmails ?? 0}</p>
      <p><strong>Already processed:</strong> {result.alreadyProcessed ?? 0}</p>
      <p><strong>Missing emails found:</strong> {result.missingFound ?? 0}</p>
      <p><strong>Emails replayed:</strong> {recovered.length}</p>
      <p><strong>Workbook failures:</strong> {failures}</p>
      {recovered.map((row) => <div key={row.emailId}>
        <strong>{row.createdAt || row.emailId}</strong>: {row.processed ? "processed" : "not fully processed"} · {row.reports} reports · {row.failures} failures
      </div>)}
    </section>}
  </main>;
}

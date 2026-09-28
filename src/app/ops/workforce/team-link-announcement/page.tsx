"use client";

import { useState } from "react";

type Result = {
  error?: string;
  eligible?: number;
  sent?: number;
  failed?: number;
  skipped?: number;
  alreadyProcessed?: number;
  results?: Array<{ employeeId: string; status: string; detail?: string }>;
};

export default function TeamLinkAnnouncementPage() {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function send() {
    setSending(true);
    try {
      const response = await fetch("/api/workforce/team-link-announcement", { method: "POST" });
      const payload = await response.json() as Result;
      setResult(response.ok ? payload : { error: payload.error || `Request failed (${response.status}).` });
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "4rem auto", padding: "1.5rem" }}>
      <h1>Corner Deli team link announcement</h1>
      <p>Send this text to active Corner Deli employees who have opted in to SMS:</p>
      <blockquote>Corner Deli team: Our new team site is https://team.ordercornerdeli.com. Use your existing PIN for Employee Hub, schedules, and messages. Reply STOP to opt out.</blockquote>
      <button type="button" onClick={send} disabled={sending || Boolean(result && !result.error)}>
        {sending ? "Sending…" : "Send Corner Deli SMS"}
      </button>
      {result?.error ? <p role="alert">{result.error}</p> : null}
      {result && !result.error ? (
        <div role="status">
          <p>Eligible: {result.eligible} · Accepted: {result.sent} · Failed: {result.failed} · Skipped: {result.skipped} · Already processed: {result.alreadyProcessed}</p>
          {result.results?.filter((item) => item.status !== "accepted").map((item) => (
            <p key={item.employeeId}>{item.employeeId}: {item.detail || item.status}</p>
          ))}
        </div>
      ) : null}
    </main>
  );
}

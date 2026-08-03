"use client";

import { useEffect, useMemo, useState } from "react";
import "../../control-center.css";
import "./calls.css";

type LostCall = {
  historyId: string;
  droppedAt: string;
  caller: string;
  waitSeconds: number;
  activeCallCount: number | null;
  activeExtensions: string[];
  callbackAt: string | null;
  callbackDirection: "Inbound" | "Outbound" | null;
  callbackDelaySeconds: number | null;
  resolved: boolean;
  assessment: "Issue" | "Busy" | "Review" | "Other lines active";
  reason: string;
  chain: string;
};

type Payload = {
  range: { start: string; end: string };
  settings: { queue: string; extensions: string[]; ignoreSeconds: number; issueSeconds: number; concurrencyConfigured: boolean };
  summary: { totalAbandoned: number; ignored: number; meaningful: number; unresolved: number; issues: number; busy: number; resolved: number };
  coverage: { records: number; latestReceivedAt: string | null };
  calls: LostCall[];
};

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function duration(seconds: number | null): string {
  if (seconds === null) return "Unknown";
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} sec`;
}

function phone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return value || "Unknown";
}

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function DeliCallsPage() {
  const today = useMemo(() => dateKey(new Date()), []);
  const [start, setStart] = useState(addDays(today, -7));
  const [end, setEnd] = useState(addDays(today, 1));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNotice("");
    const query = new URLSearchParams({ start, end });
    fetch(`/api/3cx/calls?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response));
        return response.json() as Promise<Payload>;
      })
      .then(setPayload)
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [end, refreshNonce, start]);

  const rows = (payload?.calls || []).filter((call) => showResolved || !call.resolved);

  return <main className={`controlPage callsPage ${loading ? "callsLoading" : ""}`}>
    <header className="controlHeader">
      <div><p className="eyebrow">3CX queue 90</p><h1>Deli lost-call analysis</h1><p>Abandoned calls, exact queue wait, concurrent Deli line usage, and later successful contact. Tiny accidental hangups are ignored so the report does not become a monument to pocket dialing.</p></div>
      <div className="controlActions"><button disabled={loading} onClick={() => setRefreshNonce((value) => value + 1)}>Refresh</button></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}
    {payload && !payload.settings.concurrencyConfigured && <div className="noticeBar callsWarning">Add THREE_CX_DELI_EXTENSIONS in Vercel to calculate whether other Deli lines were active at the drop time.</div>}

    <section className="controlCard callsToolbar">
      <label>Start date<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>End date, exclusive<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      <label className="resolvedToggle"><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} />Show calls resolved by later contact</label>
      <div><span>Last CDR received</span><strong>{payload?.coverage.latestReceivedAt ? new Date(payload.coverage.latestReceivedAt).toLocaleString() : "No CDR received"}</strong></div>
    </section>

    <section className="callSummary">
      <article className="controlCard"><span>Meaningful abandoned</span><strong>{payload?.summary.meaningful || 0}</strong><small>{payload?.summary.ignored || 0} trivial calls ignored</small></article>
      <article className="controlCard"><span>Unresolved</span><strong>{payload?.summary.unresolved || 0}</strong><small>No later answered contact</small></article>
      <article className="controlCard issue"><span>Operational issues</span><strong>{payload?.summary.issues || 0}</strong><small>{payload?.settings.issueSeconds || 30}+ sec with no other Deli calls active</small></article>
      <article className="controlCard"><span>Busy-line losses</span><strong>{payload?.summary.busy || 0}</strong><small>Long wait while other Deli calls were active</small></article>
    </section>

    <section className="controlCard">
      <div className="callsContext"><span>Queue {payload?.settings.queue || "90"}</span><span>Ignore ≤ {payload?.settings.ignoreSeconds ?? 4} sec</span><span>Issue threshold ≥ {payload?.settings.issueSeconds ?? 30} sec</span><span>{payload?.coverage.records || 0} CDR records analyzed</span></div>
      <div className="tableWrap"><table className="callsTable"><thead><tr><th>Dropped</th><th>Caller</th><th>Wait</th><th>Other Deli calls</th><th>Later contact</th><th>Assessment</th></tr></thead><tbody>
        {rows.map((call) => <tr key={`${call.historyId}-${call.droppedAt}`} className={call.assessment === "Issue" && !call.resolved ? "issueRow" : ""}>
          <td><strong>{new Date(call.droppedAt).toLocaleString()}</strong><small>{call.reason}</small></td>
          <td><a href={`tel:${call.caller}`}>{phone(call.caller)}</a></td>
          <td>{duration(call.waitSeconds)}</td>
          <td>{call.activeCallCount === null ? "Not configured" : <><strong>{call.activeCallCount}</strong>{call.activeExtensions.length ? <small>Ext. {call.activeExtensions.join(", ")}</small> : null}</>}</td>
          <td>{call.callbackAt ? <><strong>{call.callbackDirection} {new Date(call.callbackAt).toLocaleString()}</strong><small>{duration(call.callbackDelaySeconds)} later</small></> : "None found"}</td>
          <td><span className={`callAssessment ${call.resolved ? "resolved" : call.assessment.toLowerCase().replaceAll(" ", "-")}`}>{call.resolved ? "Resolved" : call.assessment}</span></td>
        </tr>)}
        {!rows.length && <tr><td colSpan={6}>{loading ? "Loading call records…" : "No matching lost calls were found."}</td></tr>}
      </tbody></table></div>
    </section>
  </main>;
}

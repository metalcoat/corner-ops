"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useState } from "react";
import "../control-center.css";

type Punch = {
  id: string;
  employeeId: string;
  employeeName: string;
  position: string;
  roleGroup: string;
  clockIn: string | null;
  clockOut: string | null;
  status: string;
  notes: string;
  source: string;
};

type Dashboard = {
  weekStart: string;
  punches: Punch[];
};

const TIME_ZONE = "America/New_York";

function previousMonday() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7) - 7);
  return date.toISOString().slice(0, 10);
}

function easternInputValue(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function easternLabel(value: string | null) {
  if (!value) return "Open";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Invalid time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

export default function TikiTimeCorrectionsPage() {
  const [weekStart, setWeekStart] = useState(previousMonday());
  const [data, setData] = useState<Dashboard | null>(null);
  const [editing, setEditing] = useState<Punch | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(activeWeek = weekStart) {
    const response = await fetch(`/api/tiki-time-corrections?weekStart=${encodeURIComponent(activeWeek)}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Dashboard);
  }

  useEffect(() => {
    setNotice("");
    void load(weekStart).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/tiki-time-corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json();
      await load();
      return result;
    } finally {
      setBusy(false);
    }
  }

  async function saveCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    try {
      await post({
        action: "correct",
        sourceId: editing.id,
        employeeName: form.get("employeeName"),
        position: form.get("position"),
        clockInWall: form.get("clockIn"),
        clockOutWall: form.get("clockOut"),
        reason: form.get("reason"),
      });
      setEditing(null);
      setNotice("Tiki punch corrected. Payroll and tip allocation will use the corrected times.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function useAsPriorOut(punch: Punch) {
    if (!window.confirm(
      `${punch.employeeName}: use ${easternLabel(punch.clockIn)} as the previous shift's clock-out and zero this mistaken punch?`,
    )) return;
    try {
      await post({ action: "use-in-as-prior-out", sourceId: punch.id });
      setEditing(null);
      setNotice("The lunch/duplicate IN was moved to the prior shift as its OUT, and the mistaken row was zeroed.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Tiki · owner payroll repair</p>
        <h1>Tiki punch corrections</h1>
        <p>Edit clock times directly in Eastern Time. A reason is optional; blank corrections are automatically audited as “Owner time correction.”</p>
      </div>
      <div className="controlActions">
        <label>Payroll week<input type="date" value={weekStart} onChange={(event) => { setWeekStart(event.target.value); setEditing(null); }} /></label>
        <a href="/ops/payroll-control">Back to payroll control</a>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <div className="controlGrid">
      <section className="controlCard">
        <p className="eyebrow">How to fix the lunch-punch problem</p>
        <h2>When an “IN” was really an “OUT”</h2>
        <p className="reportNote">Use <strong>This IN was prior OUT</strong> only when that punch is genuinely the mistaken lunch/duplicate IN. Corner Ops will close the closest earlier shift at that timestamp and make this mistaken row zero-length so it does not add hours. Every change remains in the audit history.</p>
      </section>

      <section className="controlCard">
        <p className="eyebrow">Eastern Time</p>
        <h2>Punches for the selected week</h2>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Employee</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{data?.punches.map((punch) => <tr key={punch.id}>
            <td><strong>{punch.employeeName}</strong><small>{punch.position}</small></td>
            <td>{easternLabel(punch.clockIn)}</td>
            <td>{easternLabel(punch.clockOut)}</td>
            <td><span className={`badge ${punch.status === "Complete" || punch.status === "Corrected" ? "good" : "warn"}`}>{punch.status}</span></td>
            <td>
              <div className="controlActions">
                <button onClick={() => setEditing(punch)} disabled={busy}>Edit times</button>
                <button onClick={() => void useAsPriorOut(punch)} disabled={busy || !punch.clockIn}>This IN was prior OUT</button>
              </div>
            </td>
          </tr>)}</tbody>
        </table></div>
        {!data?.punches.length && <div className="emptyState">No Tiki punches were found for this payroll week.</div>}
      </section>

      {editing && <section className="controlCard modalish">
        <p className="eyebrow">Owner correction · Eastern Time</p>
        <h2>{editing.employeeName}</h2>
        <form className="controlForm" onSubmit={saveCorrection}>
          <label>Employee<input name="employeeName" defaultValue={editing.employeeName} /></label>
          <label>Position<input name="position" defaultValue={editing.position} /></label>
          <label>Clock in (ET)<input name="clockIn" type="datetime-local" defaultValue={easternInputValue(editing.clockIn)} required /></label>
          <label>Clock out (ET)<input name="clockOut" type="datetime-local" defaultValue={easternInputValue(editing.clockOut)} /></label>
          <label className="wide">Reason <small>Optional</small><textarea name="reason" placeholder="Leave blank for Owner time correction" /></label>
          <div className="controlActions wide">
            <button className="primary" disabled={busy}>Save correction</button>
            <button type="button" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
          </div>
        </form>
      </section>}
    </div>
  </main>;
}

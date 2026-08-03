"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Business } from "@/lib/types";
import "./attendance.css";

type EmployeeSession = { employeeId: string; business: Business; name: string; position: string };
type AttendanceCase = {
  id: string;
  employeeName: string;
  position: string;
  scheduledStart: string;
  scheduledEnd: string;
  correctionStart: string | null;
  correctionEnd: string | null;
  employeeNote: string;
  submissionChannel: string;
  status: string;
  managerNote: string;
};
type Payload = { business: Business; employeeId: string; cases: AttendanceCase[] };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function inputDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function local(value: string | null) {
  if (!value) return "Not provided";
  return new Date(value).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function EmployeeAttendancePage() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [checked, setChecked] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelectedId(new URLSearchParams(window.location.search).get("case") || "");
    fetch("/api/employee/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { session?: EmployeeSession | null }) => setSession(payload.session || null))
      .finally(() => setChecked(true));
  }, []);

  async function load() {
    const response = await fetch("/api/employee/attendance", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as Payload;
    setData(payload);
    if (!selectedId && payload.cases[0]) setSelectedId(payload.cases[0].id);
  }

  useEffect(() => {
    if (!session) return;
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/employee/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business: form.get("business"), pin: form.get("pin") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { session: EmployeeSession };
      setSession(payload.session);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          id: form.get("id"),
          correctionStart: form.get("correctionStart"),
          correctionEnd: form.get("correctionEnd"),
          reason: form.get("reason"),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice("Correction submitted. Management approval is still required before payroll changes.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Correction submission failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!checked) return <main className="attendanceEmployeeShell"><section className="attendanceEmployeeCard"><h1>Loading attendance corrections</h1></section></main>;
  if (!session) return <main className="attendanceEmployeeShell"><section className="attendanceEmployeeCard login"><p className="attendanceEyebrow">Corner Ops Employee Hub</p><h1>Correct a missed shift</h1><p>Sign in with your normal five-digit Employee Hub PIN.</p>{notice && <div className="attendanceNotice">{notice}</div>}<form onSubmit={login}><label>Location<select name="business" defaultValue="Corner Deli"><option>Corner Deli</option><option>Tiki</option></select></label><label>Five-digit PIN<input name="pin" inputMode="numeric" pattern="\d{5}" maxLength={5} required /></label><button disabled={busy}>Sign in</button></form><a href="/employee">Return to Employee Hub</a></section></main>;

  const selected = data?.cases.find((item) => item.id === selectedId) || data?.cases[0] || null;
  const editable = selected && ["Awaiting Reply", "Rejected"].includes(selected.status);

  return <main className="attendanceEmployeeShell">
    <header className="attendanceEmployeeHero"><div><p className="attendanceEyebrow">{session.business} · {session.name}</p><h1>Attendance corrections</h1><p>Submit the times you actually worked and explain the missing record. Management approves the change before payroll.</p></div><a href="/employee">Employee Hub</a></header>
    {notice && <div className="attendanceNotice">{notice}</div>}
    <div className="attendanceEmployeeGrid">
      <aside className="attendanceEmployeeCard"><h2>Cases</h2><div className="attendanceCaseButtons">{(data?.cases || []).map((item) => <button key={item.id} className={item.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(item.id)}><strong>{local(item.scheduledStart)}</strong><span>{item.position} · {item.status}</span></button>)}{!data?.cases.length && <p>No missed-shift cases.</p>}</div></aside>
      <section className="attendanceEmployeeCard">{selected ? <><div className="attendanceCaseHeader"><div><p className="attendanceEyebrow">Scheduled shift</p><h2>{selected.position}</h2></div><span className={`attendanceStatus ${selected.status.toLowerCase().replaceAll(" ", "-")}`}>{selected.status}</span></div><div className="attendanceScheduled"><strong>{local(selected.scheduledStart)}</strong><span>to {local(selected.scheduledEnd)}</span></div>{selected.status === "Submitted" && <div className="attendanceReadOnly"><strong>Submitted correction</strong><span>{local(selected.correctionStart)} to {local(selected.correctionEnd)}</span><p>{selected.employeeNote}</p><small>Submitted through {selected.submissionChannel}. Waiting for management approval.</small></div>}{selected.status === "Approved" && <div className="attendanceReadOnly approved"><strong>Approved</strong><span>{local(selected.correctionStart)} to {local(selected.correctionEnd)}</span><p>{selected.employeeNote}</p></div>}{editable && <form className="attendanceCorrectionForm" onSubmit={submit}><input type="hidden" name="id" value={selected.id} /><label>Actual clock-in<input type="datetime-local" name="correctionStart" defaultValue={inputDateTime(selected.correctionStart || selected.scheduledStart)} required /></label><label>Actual clock-out<input type="datetime-local" name="correctionEnd" defaultValue={inputDateTime(selected.correctionEnd || selected.scheduledEnd)} required /></label><label className="wide">What happened?<textarea name="reason" rows={6} defaultValue={selected.employeeNote} placeholder="Example: I worked the scheduled shift but forgot to clock in. I clocked out at 10:08 PM." required /></label>{selected.status === "Rejected" && selected.managerNote && <div className="attendanceManagerNote">Management note: {selected.managerNote}</div>}<button disabled={busy}>Submit for approval</button></form>}</> : <p>Select a missed-shift case.</p>}</section>
    </div>
  </main>;
}

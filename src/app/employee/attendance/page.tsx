"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useMemo, useState } from "react";
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
type AttendancePayload = { business: Business; employeeId: string; cases: AttendanceCase[] };
type TimeRecord = {
  id: string;
  clock_in: string | null;
  clock_out: string | null;
  position: string;
  status: string;
  source: string;
  reported_hours?: number;
};
type Correction = {
  id: string;
  source_type: string;
  reason: string;
  status: string;
  requested_clock_in: string | null;
  requested_clock_out: string | null;
  created_at: string;
};
type EmployeePayload = {
  recentTime: TimeRecord[];
  corrections: Correction[];
};


function inputDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function local(value: string | null) {
  if (!value) return "Not provided";
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function EmployeeAttendancePage() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [checked, setChecked] = useState(false);
  const [data, setData] = useState<AttendancePayload | null>(null);
  const [employeeData, setEmployeeData] = useState<EmployeePayload | null>(null);
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
    const [attendanceResponse, employeeResponse] = await Promise.all([
      fetch("/api/employee/attendance", { cache: "no-store" }),
      fetch("/api/employee", { cache: "no-store" }),
    ]);
    if (!attendanceResponse.ok) throw new Error(await responseMessage(attendanceResponse));
    if (!employeeResponse.ok) throw new Error(await responseMessage(employeeResponse));
    const attendancePayload = await attendanceResponse.json() as AttendancePayload;
    const employeePayload = await employeeResponse.json() as EmployeePayload;
    setData(attendancePayload);
    setEmployeeData(employeePayload);
    const firstActionable = attendancePayload.cases.find((item) => ["Awaiting Correction", "Rejected"].includes(item.status));
    if (!selectedId && (firstActionable || attendancePayload.cases[0])) {
      setSelectedId((firstActionable || attendancePayload.cases[0]).id);
    }
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

  async function submitAttendanceCorrection(event: FormEvent<HTMLFormElement>) {
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
      window.dispatchEvent(new Event("corner-ops-attendance-updated"));
      setNotice("Correction submitted. Management approval is still required before payroll changes.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Correction submission failed.");
    } finally {
      setBusy(false);
    }
  }

  async function didNotWork(item: AttendanceCase) {
    const confirmed = window.confirm(
      `Confirm that you did not work the scheduled ${item.position || "shift"} beginning ${local(item.scheduledStart)}.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "did-not-work",
          id: item.id,
          reason: "Employee reported they did not work this scheduled shift.",
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      window.dispatchEvent(new Event("corner-ops-attendance-updated"));
      setNotice("Attendance item dismissed. It remains in history as employee-reported no work.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The attendance item could not be dismissed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestTimeCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "time-correction-request",
          sourceId: form.get("sourceId"),
          requestedClockIn: form.get("requestedClockIn") || null,
          requestedClockOut: form.get("requestedClockOut") || null,
          reason: form.get("reason"),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await load();
      setNotice("Time correction submitted for review.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The time correction could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  const selected = data?.cases.find((item) => item.id === selectedId) || data?.cases[0] || null;
  const editable = selected && ["Awaiting Correction", "Rejected"].includes(selected.status);
  const actionableCount = useMemo(
    () => (data?.cases || []).filter((item) => ["Awaiting Correction", "Rejected"].includes(item.status)).length,
    [data?.cases],
  );

  if (!checked) {
    return <main className="attendanceEmployeeShell"><section className="attendanceEmployeeCard"><h1>Loading attendance</h1></section></main>;
  }

  if (!session) {
    return <main className="attendanceEmployeeShell"><section className="attendanceEmployeeCard login">
      <p className="attendanceEyebrow">Corner Ops Employee Hub</p>
      <h1>Attendance</h1>
      <p>Sign in with your normal five-digit Employee Hub PIN.</p>
      {notice && <div className="attendanceNotice">{notice}</div>}
      <form onSubmit={login}>
        <label>Location<select name="business" defaultValue="Corner Deli"><option>Corner Deli</option><option>Tiki</option></select></label>
        <label>Five-digit PIN<input name="pin" inputMode="numeric" pattern="\d{5}" maxLength={5} required /></label>
        <button disabled={busy}>Sign in</button>
      </form>
      <a href="/employee">Return to Employee Hub</a>
    </section></main>;
  }

  return <main className="attendanceEmployeeShell">
    <header className="attendanceEmployeeHero">
      <div>
        <p className="attendanceEyebrow">{session.business} · {session.name}</p>
        <h1>Attendance</h1>
        <p>Missing scheduled shifts, time records, and correction requests are kept together here.</p>
      </div>
      <a href="/employee">Employee Hub</a>
    </header>

    {notice && <div className="attendanceNotice">{notice}</div>}

    <section className="attendanceSectionHeading">
      <div><p className="attendanceEyebrow">Scheduled shift review</p><h2>Attendance corrections</h2></div>
      {actionableCount > 0 && <span className="attendanceCountBubble">{actionableCount}</span>}
    </section>

    <div className="attendanceEmployeeGrid">
      <aside className="attendanceEmployeeCard">
        <h2>Cases</h2>
        <div className="attendanceCaseButtons">
          {(data?.cases || []).map((item) => <button
            key={item.id}
            className={item.id === selected?.id ? "active" : ""}
            onClick={() => setSelectedId(item.id)}
          >
            <strong>{local(item.scheduledStart)}</strong>
            <span>{item.position} · {item.status}</span>
          </button>)}
          {!data?.cases.length && <p>No attendance cases.</p>}
        </div>
      </aside>

      <section className="attendanceEmployeeCard">
        {selected ? <>
          <div className="attendanceCaseHeader">
            <div><p className="attendanceEyebrow">Scheduled shift</p><h2>{selected.position}</h2></div>
            <span className={`attendanceStatus ${selected.status.toLowerCase().replaceAll(" ", "-")}`}>{selected.status}</span>
          </div>
          <div className="attendanceScheduled"><strong>{local(selected.scheduledStart)}</strong><span>to {local(selected.scheduledEnd)}</span></div>

          {selected.status === "Submitted" && <div className="attendanceReadOnly">
            <strong>Submitted correction</strong>
            <span>{local(selected.correctionStart)} to {local(selected.correctionEnd)}</span>
            <p>{selected.employeeNote}</p>
            <small>Waiting for management approval.</small>
          </div>}

          {selected.status === "Approved" && <div className="attendanceReadOnly approved">
            <strong>Approved</strong>
            <span>{local(selected.correctionStart)} to {local(selected.correctionEnd)}</span>
            <p>{selected.employeeNote}</p>
          </div>}

          {selected.status === "Resolved" && <div className="attendanceReadOnly resolved">
            <strong>Resolved</strong>
            <p>{selected.employeeNote || selected.managerNote || "This attendance item has been resolved."}</p>
            <small>{selected.submissionChannel || "Attendance history"}</small>
          </div>}

          {editable && <form className="attendanceCorrectionForm" onSubmit={submitAttendanceCorrection}>
            <input type="hidden" name="id" value={selected.id} />
            <label>Actual clock-in<input type="datetime-local" name="correctionStart" defaultValue={inputDateTime(selected.correctionStart || selected.scheduledStart)} required /></label>
            <label>Actual clock-out<input type="datetime-local" name="correctionEnd" defaultValue={inputDateTime(selected.correctionEnd || selected.scheduledEnd)} required /></label>
            <label className="wide">What happened?<textarea name="reason" rows={6} defaultValue={selected.employeeNote} placeholder="Example: I worked the scheduled shift but forgot to clock in." required /></label>
            {selected.status === "Rejected" && selected.managerNote && <div className="attendanceManagerNote">Management note: {selected.managerNote}</div>}
            <div className="attendanceActionRow">
              <button type="button" className="attendanceNoWorkButton" disabled={busy} onClick={() => void didNotWork(selected)}>I did not work</button>
              <button disabled={busy}>Submit corrected time</button>
            </div>
          </form>}
        </> : <p>Select an attendance case.</p>}
      </section>
    </div>

    <section className="attendanceSectionHeading attendanceTimeHeading">
      <div><p className="attendanceEyebrow">Time and payroll records</p><h2>Time & corrections</h2></div>
    </section>

    <section className="attendanceTimeGrid">
      <article className="attendanceEmployeeCard attendanceCorrectionRequestCard">
        <div className="attendanceCardTitle"><p className="attendanceEyebrow">Fix a punch</p><h2>Request a time correction</h2></div>
        <form className="attendanceTimeForm" onSubmit={requestTimeCorrection}>
          <label>Time record<select name="sourceId" required><option value="">Choose record</option>{(employeeData?.recentTime || []).map((record) => <option key={record.id} value={record.id}>{local(record.clock_in || record.clock_out)} · {record.position}</option>)}</select></label>
          <label>Correct clock-in<input name="requestedClockIn" type="datetime-local" /></label>
          <label>Correct clock-out<input name="requestedClockOut" type="datetime-local" /></label>
          <label>Reason<textarea name="reason" rows={3} required /></label>
          <button disabled={busy}>Submit correction</button>
        </form>
      </article>

      <article className="attendanceEmployeeCard attendanceRecentTimeCard">
        <div className="attendanceCardTitle"><p className="attendanceEyebrow">Recent</p><h2>Time records</h2></div>
        <div className="attendanceHistoryList">
          {(employeeData?.recentTime || []).map((record) => <div className="attendanceHistoryItem" key={record.id}>
            <strong>{record.position || "Shift"} · {record.status}</strong>
            <span>{local(record.clock_in)} to {record.clock_out ? local(record.clock_out) : "Missing clock-out"}</span>
            {record.reported_hours !== undefined && <small>{Number(record.reported_hours || 0).toFixed(2)} reported hours</small>}
          </div>)}
          {!employeeData?.recentTime.length && <p>No recent time records.</p>}
        </div>
      </article>

      <article className="attendanceEmployeeCard attendanceTimeWide">
        <div className="attendanceCardTitle"><p className="attendanceEyebrow">Review status</p><h2>Correction requests</h2></div>
        <div className="attendanceHistoryList">
          {(employeeData?.corrections || []).map((correction) => <div className="attendanceHistoryItem" key={correction.id}>
            <strong>{correction.status} · {correction.source_type}</strong>
            <span>{local(correction.created_at)}</span>
            <p>{correction.reason}</p>
            <small>{inputDateTime(correction.requested_clock_in) || "No clock-in change"} to {inputDateTime(correction.requested_clock_out) || "No clock-out change"}</small>
          </div>)}
          {!employeeData?.corrections.length && <p>No correction requests.</p>}
        </div>
      </article>
    </section>
  </main>;
}

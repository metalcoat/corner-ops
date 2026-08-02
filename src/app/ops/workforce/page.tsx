"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "./workforce.css";

type Employee = { id: string; name: string; position: string; roleGroup: string; active: boolean };
type Shift = {
  id: string;
  employeeId: string | null;
  employeeName: string;
  position: string;
  startsAt: string;
  endsAt: string;
  status: string;
  notes: string;
};
type ShiftRequest = {
  id: string;
  request_type: "Claim" | "Offer" | "Swap";
  requester_name: string;
  target_name: string | null;
  employee_response: string;
  status: string;
  note: string;
  starts_at: string;
  ends_at: string;
  position: string;
  offered_starts_at: string | null;
};
type Correction = {
  id: string;
  employee_name: string;
  source_type: string;
  original_clock_in: string | null;
  original_clock_out: string | null;
  requested_clock_in: string | null;
  requested_clock_out: string | null;
  reason: string;
  status: string;
};
type TimeOff = {
  id: string;
  employee_name: string;
  starts_on: string;
  ends_on: string;
  reason: string;
  status: string;
};
type Message = {
  id: string;
  sender_name: string;
  recipient_name: string | null;
  message_type: string;
  body: string;
  created_at: string;
};
type Availability = {
  id: string;
  employee_name: string;
  weekday: number;
  available: boolean;
  available_from: string;
  available_to: string;
  notes: string;
};
type WorkforceData = {
  business: Business;
  employees: Employee[];
  shifts: Shift[];
  shiftRequests: ShiftRequest[];
  messages: Message[];
  corrections: Correction[];
  timeOff: TimeOff[];
  availability: Availability[];
};
type Tab = "schedule" | "messages" | "requests" | "corrections" | "availability";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function local(value: string | null) {
  if (!value) return "Missing";
  return new Date(value).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function dateOnly(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function mondayFor(date = new Date()) {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  return next.toISOString().slice(0, 10);
}

export default function WorkforcePage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<WorkforceData | null>(null);
  const [tab, setTab] = useState<Tab>("schedule");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach server"] }));
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/workforce?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as WorkforceData);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business]);

  async function action(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/workforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, business }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The operation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const employeeId = String(form.get("employeeId") || "");
    const status = String(form.get("status") || "Draft");
    await action({
      action: "shift-create",
      employeeId: employeeId || null,
      position: form.get("position"),
      startsAt: form.get("startsAt"),
      endsAt: form.get("endsAt"),
      status: employeeId ? status : "Open",
      notes: form.get("notes"),
    }, "Shift added.");
    formElement.reset();
  }

  async function copyWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action({ action: "week-copy", sourceWeekStart: form.get("sourceWeekStart") }, "Schedule copied into next week as drafts.");
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({
      action: "message-send",
      recipientEmployeeId: form.get("recipientEmployeeId") || null,
      body: form.get("body"),
    }, "Message sent.");
    formElement.reset();
  }

  const activeEmployees = data?.employees.filter((employee) => employee.active) || [];
  const pendingRequests = data?.shiftRequests.filter((request) => request.status === "Pending") || [];
  const pendingCorrections = data?.corrections.filter((request) => request.status === "Pending") || [];
  const pendingTimeOff = data?.timeOff.filter((request) => request.status === "Pending") || [];
  const futureShifts = useMemo(() => (data?.shifts || []).filter((shift) => new Date(shift.endsAt).getTime() >= Date.now() && shift.status !== "Cancelled"), [data?.shifts]);

  if (!session) return <main className="workforceShell"><div className="workforcePanel"><h1>Loading workforce</h1></div></main>;
  if (!session.authenticated) return <main className="workforceShell"><div className="workforcePanel"><h1>Owner access required</h1><a className="wfPrimary" href="/">Return to sign-in</a></div></main>;

  return <main className="workforceShell">
    <header className="workforceHero">
      <div>
        <p className="wfEyebrow">People, schedules, and corrections</p>
        <h1>Workforce Admin</h1>
        <p>Build both schedules, publish shifts, handle swaps, message staff, and review corrections from each location's actual time source.</p>
      </div>
      <div className="wfBusinessSwitch">
        {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}
      </div>
    </header>

    {notice && <div className="wfNotice">{notice}</div>}

    <section className="wfStats">
      <article><span>Active employees</span><strong>{activeEmployees.length}</strong></article>
      <article><span>Upcoming shifts</span><strong>{futureShifts.length}</strong></article>
      <article><span>Shift requests</span><strong>{pendingRequests.length}</strong></article>
      <article><span>Corrections</span><strong>{pendingCorrections.length}</strong></article>
      <article><span>Time off</span><strong>{pendingTimeOff.length}</strong></article>
    </section>

    <nav className="wfTabs">
      {(["schedule", "messages", "requests", "corrections", "availability"] as Tab[]).map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name === "availability" ? "Availability & time off" : name[0].toUpperCase() + name.slice(1)}</button>)}
    </nav>

    {tab === "schedule" && <section className="wfTwoColumn">
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Create</p><h2>Add a shift</h2></div></div>
        <form className="wfForm" onSubmit={createShift}>
          <label>Employee<select name="employeeId" defaultValue=""><option value="">Open shift</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.position}</option>)}</select></label>
          <label>Position<input name="position" placeholder={business === "Tiki" ? "Bartender" : "Driver / Chef / Manager"} required /></label>
          <label>Starts<input name="startsAt" type="datetime-local" required /></label>
          <label>Ends<input name="endsAt" type="datetime-local" required /></label>
          <label>Status<select name="status" defaultValue="Published"><option>Draft</option><option>Published</option><option>Open</option></select></label>
          <label className="wfWide">Notes<textarea name="notes" rows={3} /></label>
          <button className="wfPrimary" disabled={busy}>Add shift</button>
        </form>
        <form className="wfInlineForm" onSubmit={copyWeek}>
          <label>Copy week beginning<input name="sourceWeekStart" type="date" defaultValue={mondayFor()} required /></label>
          <button className="wfSecondary" disabled={busy}>Copy to next week</button>
        </form>
      </article>

      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Published and draft</p><h2>Schedule</h2></div><a href="/employee" className="wfTextLink">Employee view</a></div>
        <div className="wfList">
          {futureShifts.map((shift) => <div className="wfShift" key={shift.id}>
            <div><strong>{shift.employeeName || "Open shift"}</strong><span>{shift.position || "Shift"}</span><small>{local(shift.startsAt)} to {new Date(shift.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>{shift.notes && <small>{shift.notes}</small>}</div>
            <div className="wfActions"><span className={`wfBadge ${shift.status.toLowerCase()}`}>{shift.status}</span>{shift.status === "Draft" && <button disabled={busy} onClick={() => void action({ action: "shift-update", id: shift.id, status: shift.employeeId ? "Published" : "Open" }, "Shift published.")}>Publish</button>}{shift.employeeId && shift.status !== "Cancelled" && <button disabled={busy} onClick={() => void action({ action: "shift-update", id: shift.id, status: "Open", employeeId: null }, "Shift opened for claims.")}>Make open</button>}<button disabled={busy} onClick={() => void action({ action: "shift-update", id: shift.id, status: "Cancelled" }, "Shift cancelled.")}>Cancel</button></div>
          </div>)}
          {futureShifts.length === 0 && <p className="wfEmpty">No upcoming shifts yet.</p>}
        </div>
      </article>
    </section>}

    {tab === "messages" && <section className="wfTwoColumn">
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Team communication</p><h2>Send a message</h2></div></div>
        <form className="wfForm oneColumn" onSubmit={sendMessage}>
          <label>Recipient<select name="recipientEmployeeId" defaultValue=""><option value="">Everyone at {business}</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
          <label>Message<textarea name="body" rows={6} required /></label>
          <button className="wfPrimary" disabled={busy}>Send</button>
        </form>
      </article>
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Recent</p><h2>Message board</h2></div></div>
        <div className="wfList">{(data?.messages || []).map((message) => <div className="wfMessage" key={message.id}><div><strong>{message.sender_name}</strong><span>{message.recipient_name ? `to ${message.recipient_name}` : message.message_type}</span></div><p>{message.body}</p><small>{local(message.created_at)}</small></div>)}{!data?.messages.length && <p className="wfEmpty">No messages yet.</p>}</div>
      </article>
    </section>}

    {tab === "requests" && <section className="wfTwoColumn">
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Claims, offers, and swaps</p><h2>Shift requests</h2></div></div>
        <div className="wfList">{(data?.shiftRequests || []).map((request) => <div className="wfRequest" key={request.id}><div><strong>{request.request_type}: {request.requester_name}</strong><span>{request.target_name ? `with ${request.target_name}` : "Manager review"}</span><small>{local(request.starts_at)} · {request.position}</small>{request.note && <p>{request.note}</p>}<small>Employee response: {request.employee_response}</small></div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void action({ action: "shift-request-review", id: request.id, approve: true }, "Shift request approved.")}>Approve</button><button disabled={busy} onClick={() => void action({ action: "shift-request-review", id: request.id, approve: false }, "Shift request rejected.")}>Reject</button></>}</div></div>)}{!data?.shiftRequests.length && <p className="wfEmpty">No shift requests.</p>}</div>
      </article>
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Requested days away</p><h2>Time off</h2></div></div>
        <div className="wfList">{(data?.timeOff || []).map((request) => <div className="wfRequest" key={request.id}><div><strong>{request.employee_name}</strong><span>{dateOnly(request.starts_on)} through {dateOnly(request.ends_on)}</span>{request.reason && <p>{request.reason}</p>}</div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void action({ action: "time-off-review", id: request.id, approve: true }, "Time off approved.")}>Approve</button><button disabled={busy} onClick={() => void action({ action: "time-off-review", id: request.id, approve: false }, "Time off rejected.")}>Reject</button></>}</div></div>)}{!data?.timeOff.length && <p className="wfEmpty">No time-off requests.</p>}</div>
      </article>
    </section>}

    {tab === "corrections" && <section className="workforcePanel">
      <div className="wfPanelHeader"><div><p className="wfEyebrow">Source-aware review</p><h2>Time clock corrections</h2></div><span className="wfSourceNote">{business === "Tiki" ? "Corner Ops punches" : "Rezku imported shifts"}</span></div>
      <div className="wfList">{(data?.corrections || []).map((request) => <div className="wfCorrection" key={request.id}><div><strong>{request.employee_name} · {request.source_type}</strong><span>Original: {local(request.original_clock_in)} to {local(request.original_clock_out)}</span><span>Requested: {local(request.requested_clock_in)} to {local(request.requested_clock_out)}</span><p>{request.reason}</p></div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void action({ action: "time-correction-review", id: request.id, approve: true }, "Correction approved and applied.")}>Approve & apply</button><button disabled={busy} onClick={() => void action({ action: "time-correction-review", id: request.id, approve: false }, "Correction rejected.")}>Reject</button></>}</div></div>)}{!data?.corrections.length && <p className="wfEmpty">No correction requests.</p>}</div>
    </section>}

    {tab === "availability" && <section className="workforcePanel">
      <div className="wfPanelHeader"><div><p className="wfEyebrow">Recurring weekly preferences</p><h2>Employee availability</h2></div></div>
      <div className="wfAvailabilityGrid">{activeEmployees.map((employee) => <article key={employee.id}><h3>{employee.name}</h3>{weekdays.map((day, index) => { const row = data?.availability.find((item) => item.employee_name === employee.name && item.weekday === index); return <div key={day}><strong>{day.slice(0, 3)}</strong><span>{row ? row.available ? `${row.available_from || "Any"} to ${row.available_to || "Any"}` : "Unavailable" : "Not set"}</span></div>; })}</article>)}</div>
    </section>}
  </main>;
}

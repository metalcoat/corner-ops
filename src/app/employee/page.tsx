"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business } from "@/lib/types";
import "./employee.css";

type EmployeeSession = { employeeId: string; business: Business; name: string; position: string };
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
type DirectoryEmployee = { id: string; name: string; position: string };
type Message = { id: string; sender_name: string; recipient_name: string | null; message_type: string; body: string; created_at: string };
type ShiftRequest = {
  id: string;
  request_type: string;
  requester_employee_id: string;
  target_employee_id: string | null;
  requester_name: string;
  target_name: string | null;
  employee_response: string;
  status: string;
  note: string;
  starts_at: string;
  position: string;
};
type TimeRecord = { id: string; clock_in: string | null; clock_out: string | null; position: string; status: string; source: string; reported_hours?: number };
type Correction = { id: string; source_type: string; reason: string; status: string; requested_clock_in: string | null; requested_clock_out: string | null; created_at: string };
type TimeOff = { id: string; starts_on: string; ends_on: string; reason: string; status: string };
type Availability = { weekday: number; available: boolean; available_from: string; available_to: string; notes: string };
type EmployeeData = {
  employee: DirectoryEmployee;
  business: Business;
  teamShifts: Shift[];
  messages: Message[];
  shiftRequests: ShiftRequest[];
  corrections: Correction[];
  timeOff: TimeOff[];
  availability: Availability[];
  recentTime: TimeRecord[];
  directory: DirectoryEmployee[];
};
type Tab = "schedule" | "messages" | "requests" | "time" | "availability";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function local(value: string | null) {
  if (!value) return "Missing";
  return new Date(value).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function inputDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export default function EmployeePage() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [checked, setChecked] = useState(false);
  const [data, setData] = useState<EmployeeData | null>(null);
  const [tab, setTab] = useState<Tab>("schedule");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/employee/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { session?: EmployeeSession | null }) => setSession(payload.session || null))
      .finally(() => setChecked(true));
  }, []);

  async function load() {
    const response = await fetch("/api/employee", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as EmployeeData);
  }

  useEffect(() => {
    if (!session) return;
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
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

  async function logout() {
    await fetch("/api/employee/session", { method: "DELETE" });
    setSession(null);
    setData(null);
  }

  async function action(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({ action: "message-send", recipientEmployeeId: form.get("recipientEmployeeId") || null, body: form.get("body") }, "Message sent.");
    formElement.reset();
  }

  async function requestSwap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({
      action: "shift-request",
      requestType: "Swap",
      shiftId: form.get("shiftId"),
      offeredShiftId: form.get("offeredShiftId"),
      note: form.get("note"),
    }, "Swap request sent to the other employee.");
    formElement.reset();
  }

  async function requestCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({
      action: "time-correction-request",
      sourceId: form.get("sourceId"),
      requestedClockIn: form.get("requestedClockIn") || null,
      requestedClockOut: form.get("requestedClockOut") || null,
      reason: form.get("reason"),
    }, "Time correction submitted for review.");
    formElement.reset();
  }

  async function saveAvailability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({
      action: "availability-save",
      weekday: Number(form.get("weekday")),
      available: form.get("available") === "yes",
      availableFrom: form.get("availableFrom"),
      availableTo: form.get("availableTo"),
      notes: form.get("notes"),
    }, "Availability saved.");
    formElement.reset();
  }

  async function requestDaysOff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({ action: "time-off-request", startsOn: form.get("startsOn"), endsOn: form.get("endsOn"), reason: form.get("reason") }, "Time-off request submitted.");
    formElement.reset();
  }

  const myShifts = useMemo(() => (data?.teamShifts || []).filter((shift) => shift.employeeId === session?.employeeId), [data?.teamShifts, session?.employeeId]);
  const openShifts = useMemo(() => (data?.teamShifts || []).filter((shift) => !shift.employeeId && shift.status === "Open"), [data?.teamShifts]);
  const otherShifts = useMemo(() => (data?.teamShifts || []).filter((shift) => shift.employeeId && shift.employeeId !== session?.employeeId && shift.status === "Published"), [data?.teamShifts, session?.employeeId]);
  const incomingRequests = (data?.shiftRequests || []).filter((request) => request.target_employee_id === session?.employeeId && request.employee_response === "Pending" && request.status === "Pending");

  if (!checked) return <main className="employeeShell"><section className="employeeCard"><h1>Loading Employee Hub</h1></section></main>;
  if (!session) return <main className="employeeLoginShell"><section className="employeeLoginCard"><p className="empEyebrow">Corner Ops</p><h1>Employee Hub</h1><p>View schedules, trade shifts, message the team, and request time corrections.</p>{notice && <div className="empNotice">{notice}</div>}<form onSubmit={login} className="employeeLoginForm"><label>Location<select name="business" defaultValue="Corner Deli"><option>Corner Deli</option><option>Tiki</option></select></label><label>Five-digit PIN<input name="pin" inputMode="numeric" pattern="\d{5}" maxLength={5} autoComplete="off" required /></label><button disabled={busy}>Sign in</button></form><a href="/clock" className="empClockLink">Tiki time clock</a></section></main>;

  return <main className="employeeShell">
    <header className="employeeHero"><div><p className="empEyebrow">{session.business}</p><h1>{session.name}</h1><p>{session.position} · Employee Hub</p></div><div className="employeeHeaderActions"><a href="/clock">Tiki clock</a><button onClick={() => void load()} disabled={busy}>Refresh</button><button onClick={() => void logout()}>Sign out</button></div></header>
    {notice && <div className="empNotice">{notice}</div>}
    <section className="employeeStats"><article><span>My upcoming shifts</span><strong>{myShifts.length}</strong></article><article><span>Open shifts</span><strong>{openShifts.length}</strong></article><article><span>Incoming requests</span><strong>{incomingRequests.length}</strong></article><article><span>Pending corrections</span><strong>{data?.corrections.filter((item) => item.status === "Pending").length || 0}</strong></article></section>
    <nav className="employeeTabs">{(["schedule", "messages", "requests", "time", "availability"] as Tab[]).map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name === "time" ? "Time & corrections" : name[0].toUpperCase() + name.slice(1)}</button>)}</nav>

    {tab === "schedule" && <section className="employeeGrid">
      <article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Assigned</p><h2>My schedule</h2></div></div><div className="employeeList">{myShifts.map((shift) => <div className="employeeShift" key={shift.id}><div><strong>{shift.position || session.position}</strong><span>{local(shift.startsAt)} to {new Date(shift.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>{shift.notes && <small>{shift.notes}</small>}</div><button disabled={busy} onClick={() => void action({ action: "shift-request", requestType: "Offer", shiftId: shift.id }, "Shift offered for manager approval.")}>Offer shift</button></div>)}{myShifts.length === 0 && <p className="empEmpty">No upcoming assigned shifts.</p>}</div></article>
      <article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Available</p><h2>Open shifts</h2></div></div><div className="employeeList">{openShifts.map((shift) => <div className="employeeShift" key={shift.id}><div><strong>{shift.position || "Open shift"}</strong><span>{local(shift.startsAt)} to {new Date(shift.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div><button disabled={busy} onClick={() => void action({ action: "shift-request", requestType: "Claim", shiftId: shift.id }, "Claim request sent to management.")}>Request shift</button></div>)}{openShifts.length === 0 && <p className="empEmpty">No open shifts.</p>}</div></article>
      <article className="employeeCard employeeWide"><div className="employeeCardHeader"><div><p className="empEyebrow">Published</p><h2>Team schedule</h2></div></div><div className="teamSchedule">{(data?.teamShifts || []).map((shift) => <div key={shift.id}><strong>{shift.employeeName || "Open"}</strong><span>{shift.position}</span><small>{local(shift.startsAt)}</small></div>)}</div></article>
    </section>}

    {tab === "messages" && <section className="employeeGrid"><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Team or direct</p><h2>Send message</h2></div></div><form className="employeeForm" onSubmit={sendMessage}><label>Recipient<select name="recipientEmployeeId" defaultValue=""><option value="">Everyone at {session.business}</option>{(data?.directory || []).filter((person) => person.id !== session.employeeId).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label>Message<textarea name="body" rows={6} required /></label><button disabled={busy}>Send</button></form></article><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Recent</p><h2>Messages</h2></div></div><div className="employeeList">{(data?.messages || []).map((message) => <div className="employeeMessage" key={message.id}><div><strong>{message.sender_name}</strong><span>{message.recipient_name ? `to ${message.recipient_name}` : message.message_type}</span></div><p>{message.body}</p><small>{local(message.created_at)}</small></div>)}{!data?.messages.length && <p className="empEmpty">No messages yet.</p>}</div></article></section>}

    {tab === "requests" && <section className="employeeGrid"><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Trade two assigned shifts</p><h2>Request a swap</h2></div></div><form className="employeeForm" onSubmit={requestSwap}><label>My shift<select name="shiftId" required><option value="">Choose shift</option>{myShifts.map((shift) => <option key={shift.id} value={shift.id}>{local(shift.startsAt)} · {shift.position}</option>)}</select></label><label>Other employee's shift<select name="offeredShiftId" required><option value="">Choose shift</option>{otherShifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.employeeName} · {local(shift.startsAt)} · {shift.position}</option>)}</select></label><label>Note<textarea name="note" rows={3} /></label><button disabled={busy}>Send swap request</button></form></article><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Action needed</p><h2>Incoming requests</h2></div></div><div className="employeeList">{incomingRequests.map((request) => <div className="employeeRequest" key={request.id}><div><strong>{request.requester_name} requested a {request.request_type.toLowerCase()}</strong><span>{local(request.starts_at)} · {request.position}</span>{request.note && <p>{request.note}</p>}</div><div><button disabled={busy} onClick={() => void action({ action: "shift-response", id: request.id, accept: true }, "Shift request accepted and sent to management.")}>Accept</button><button className="empSecondary" disabled={busy} onClick={() => void action({ action: "shift-response", id: request.id, accept: false }, "Shift request declined.")}>Decline</button></div></div>)}{incomingRequests.length === 0 && <p className="empEmpty">No incoming requests.</p>}</div></article><article className="employeeCard employeeWide"><div className="employeeCardHeader"><div><p className="empEyebrow">History</p><h2>My shift requests</h2></div></div><div className="employeeList">{(data?.shiftRequests || []).map((request) => <div className="employeeHistory" key={request.id}><strong>{request.request_type} · {request.status}</strong><span>{local(request.starts_at)} · {request.requester_name}{request.target_name ? ` / ${request.target_name}` : ""}</span></div>)}</div></article></section>}

    {tab === "time" && <section className="employeeGrid"><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">{session.business === "Tiki" ? "Corner Ops time clock" : "Rezku shift import"}</p><h2>Request correction</h2></div></div><form className="employeeForm" onSubmit={requestCorrection}><label>Time record<select name="sourceId" required defaultValue=""><option value="">Choose record</option>{(data?.recentTime || []).map((record) => <option key={record.id} value={record.id}>{local(record.clock_in)} to {record.clock_out ? new Date(record.clock_out).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Missing"} · {record.position}</option>)}</select></label><label>Correct clock-in<input name="requestedClockIn" type="datetime-local" /></label><label>Correct clock-out<input name="requestedClockOut" type="datetime-local" /></label><label>What needs fixing?<textarea name="reason" rows={4} required /></label><button disabled={busy}>Submit correction</button></form></article><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Recent source records</p><h2>My time</h2></div></div><div className="employeeList">{(data?.recentTime || []).map((record) => <div className="employeeHistory" key={record.id}><strong>{record.position} · {record.status}</strong><span>{local(record.clock_in)} to {local(record.clock_out)}</span><small>{record.source}{record.reported_hours !== undefined ? ` · ${Number(record.reported_hours).toFixed(2)} hours` : ""}</small></div>)}</div></article><article className="employeeCard employeeWide"><div className="employeeCardHeader"><div><p className="empEyebrow">Manager review</p><h2>Correction history</h2></div></div><div className="employeeList">{(data?.corrections || []).map((request) => <div className="employeeHistory" key={request.id}><strong>{request.source_type} · {request.status}</strong><span>{local(request.requested_clock_in)} to {local(request.requested_clock_out)}</span><p>{request.reason}</p></div>)}{!data?.corrections.length && <p className="empEmpty">No correction requests.</p>}</div></article></section>}

    {tab === "availability" && <section className="employeeGrid"><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Recurring week</p><h2>Set availability</h2></div></div><form className="employeeForm" onSubmit={saveAvailability}><label>Day<select name="weekday" defaultValue="1">{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label><label>Available?<select name="available" defaultValue="yes"><option value="yes">Available</option><option value="no">Unavailable</option></select></label><label>From<input name="availableFrom" type="time" /></label><label>To<input name="availableTo" type="time" /></label><label>Notes<textarea name="notes" rows={3} /></label><button disabled={busy}>Save availability</button></form><div className="availabilitySummary">{weekdays.map((day, index) => { const row = data?.availability.find((item) => item.weekday === index); return <div key={day}><strong>{day}</strong><span>{row ? row.available ? `${row.available_from || "Any time"} to ${row.available_to || "Any time"}` : "Unavailable" : "Not set"}</span></div>; })}</div></article><article className="employeeCard"><div className="employeeCardHeader"><div><p className="empEyebrow">Dates away</p><h2>Request time off</h2></div></div><form className="employeeForm" onSubmit={requestDaysOff}><label>Start<input name="startsOn" type="date" required /></label><label>End<input name="endsOn" type="date" required /></label><label>Reason<textarea name="reason" rows={4} /></label><button disabled={busy}>Request time off</button></form><div className="employeeList">{(data?.timeOff || []).map((request) => <div className="employeeHistory" key={request.id}><strong>{request.status}</strong><span>{request.starts_on} through {request.ends_on}</span>{request.reason && <p>{request.reason}</p>}</div>)}</div></article></section>}
  </main>;
}

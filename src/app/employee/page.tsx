"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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
type Message = {
  id: string;
  sender_name: string;
  recipient_name: string | null;
  message_type: string;
  body: string;
  created_at: string;
};
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
type TimeOff = { id: string; starts_on: string; ends_on: string; reason: string; status: string };
type Availability = {
  weekday: number;
  available: boolean;
  available_from: string;
  available_to: string;
  notes: string;
};
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

const businessNames: Business[] = ["Corner Deli", "Tiki"];
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const shortWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function validBusiness(value: string | null): value is Business {
  return businessNames.includes(value as Business);
}

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function local(value: string | null) {
  if (!value) return "Missing";
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function localTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function inputDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function localDateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function mondayFor(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const day = result.getDay();
  result.setDate(result.getDate() - (day === 0 ? 6 : day - 1));
  return result;
}

function messagePreview(value: string) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 72 ? `${text.slice(0, 72)}…` : text || "Photo or update";
}

function MessageDisclosure({ message, business }: { message: Message; business: Business }) {
  return <details className="employeeMessageDisclosure" data-business={business}>
    <summary>
      <span className="employeeMessageSummaryMain">
        <strong>{message.sender_name}</strong>
        <span>{messagePreview(message.body)}</span>
      </span>
      <span className="employeeMessageSummaryMeta">
        <small>{message.recipient_name ? `to ${message.recipient_name}` : message.message_type}</small>
        <time>{local(message.created_at)}</time>
      </span>
    </summary>
    <div className="employeeMessageBody"><p>{message.body}</p></div>
  </details>;
}

export default function EmployeePage() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [checked, setChecked] = useState(false);
  const [data, setData] = useState<EmployeeData | null>(null);
  const [tab, setTab] = useState<Tab>("schedule");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loginBusiness, setLoginBusiness] = useState<Business>("Corner Deli");
  const [pin, setPin] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);

  const checkSession = useCallback(async () => {
    try {
      const response = await fetch("/api/employee/session", { cache: "no-store" });
      const payload = await response.json() as { session?: EmployeeSession | null };
      setSession(payload.session || null);
    } catch {
      setSession(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    const queryBusiness = new URLSearchParams(window.location.search).get("business");
    const savedBusiness = window.localStorage.getItem("corner-ops-business-theme");
    const initialBusiness = validBusiness(queryBusiness)
      ? queryBusiness
      : validBusiness(savedBusiness)
        ? savedBusiness
        : "Corner Deli";
    setLoginBusiness(initialBusiness);
    document.documentElement.dataset.businessTheme = initialBusiness;

    void checkSession();
    const onPageShow = () => void checkSession();
    const onFocus = () => void checkSession();
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkSession]);

  useEffect(() => {
    const activeBusiness = session?.business || loginBusiness;
    document.documentElement.dataset.businessTheme = activeBusiness;
    window.localStorage.setItem("corner-ops-business-theme", activeBusiness);
  }, [loginBusiness, session?.business]);

  const load = useCallback(async () => {
    const response = await fetch("/api/employee", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as EmployeeData;
    setData(payload);
    document.documentElement.dataset.businessTheme = payload.business;
  }, []);

  useEffect(() => {
    if (!session) return;
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [load, session]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business: loginBusiness, pin }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { session: EmployeeSession };
      setSession(payload.session);
      setData(null);
      setPin("");
      setTab("schedule");
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
    setChecked(true);
    setTab("schedule");
    setPin("");
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
    await action({
      action: "message-send",
      recipientEmployeeId: form.get("recipientEmployeeId") || null,
      body: form.get("body"),
    }, "Message sent.");
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
    await action({
      action: "time-off-request",
      startsOn: form.get("startsOn"),
      endsOn: form.get("endsOn"),
      reason: form.get("reason"),
    }, "Time-off request submitted.");
    formElement.reset();
  }

  const myShifts = useMemo(
    () => (data?.teamShifts || []).filter((shift) => shift.employeeId === session?.employeeId),
    [data?.teamShifts, session?.employeeId],
  );
  const openShifts = useMemo(
    () => (data?.teamShifts || []).filter((shift) => !shift.employeeId && shift.status === "Open"),
    [data?.teamShifts],
  );
  const otherShifts = useMemo(
    () => (data?.teamShifts || []).filter(
      (shift) => shift.employeeId && shift.employeeId !== session?.employeeId && shift.status === "Published",
    ),
    [data?.teamShifts, session?.employeeId],
  );
  const incomingRequests = useMemo(
    () => (data?.shiftRequests || []).filter(
      (request) => request.target_employee_id === session?.employeeId
        && request.employee_response === "Pending"
        && request.status === "Pending",
    ),
    [data?.shiftRequests, session?.employeeId],
  );
  const latestMessages = useMemo(() => (data?.messages || []).slice(0, 5), [data?.messages]);

  const scheduleWeekStart = useMemo(() => {
    const start = mondayFor(new Date());
    start.setDate(start.getDate() + weekOffset * 7);
    return start;
  }, [weekOffset]);

  const scheduleDays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = new Date(scheduleWeekStart);
    date.setDate(date.getDate() + index);
    return date;
  }), [scheduleWeekStart]);

  const weekLabel = `${scheduleWeekStart.toLocaleDateString([], { month: "short", day: "numeric" })} – ${
    scheduleDays[6].toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
  }`;

  if (!checked) {
    return <main className="employeeShell"><section className="employeeCard"><h1>Loading Employee Hub</h1></section></main>;
  }

  if (!session) {
    return <main className="employeeLoginShell">
      <section className="employeeLoginCard">
        <p className="empEyebrow">Corner Ops</p>
        <h1>Employee Hub</h1>
        <p>View schedules, trade shifts, message the team, and request time corrections.</p>
        {notice && <div className="empNotice">{notice}</div>}
        <form onSubmit={login} className="employeeLoginForm">
          <label>
            Location
            <select
              name="business"
              value={loginBusiness}
              onChange={(event) => {
                const next = event.target.value as Business;
                setLoginBusiness(next);
                setPin("");
                setNotice("");
              }}
            >
              <option>Corner Deli</option>
              <option>Tiki</option>
            </select>
          </label>
          <label>
            Five-digit PIN
            <input
              name="pin"
              inputMode="numeric"
              pattern="\d{5}"
              maxLength={5}
              autoComplete="off"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 5))}
              required
            />
          </label>
          <button disabled={busy || pin.length !== 5}>{busy ? "Signing in…" : `Sign in to ${loginBusiness}`}</button>
        </form>
        {loginBusiness === "Tiki" && <a href="/clock" className="empClockLink">Tiki time clock</a>}
      </section>
    </main>;
  }

  return <main className="employeeShell" data-business={session.business}>
    <header className="employeeHero">
      <div><p className="empEyebrow">{session.business}</p><h1>{session.name}</h1><p>{session.position} · Employee Hub</p></div>
      <div className="employeeHeaderActions">
        {session.business === "Tiki" && <a href="/clock">Tiki clock</a>}
        <button onClick={() => void load()} disabled={busy}>Refresh</button>
        <button onClick={() => void logout()}>Sign out</button>
      </div>
    </header>

    {notice && <div className="empNotice">{notice}</div>}

    <section className="employeeStats">
      <article><span>My upcoming shifts</span><strong>{myShifts.length}</strong></article>
      <article><span>Open shifts</span><strong>{openShifts.length}</strong></article>
      <article><span>Incoming requests</span><strong>{incomingRequests.length}</strong></article>
      <article><span>New updates</span><strong>{latestMessages.length}</strong></article>
    </section>

    <details className="employeeUpdateTray">
      <summary>
        <span><strong>Latest team updates</strong><small>{latestMessages.length ? messagePreview(latestMessages[0].body) : "No recent messages"}</small></span>
        <span className="employeeUpdateCount">{data?.messages.length || 0}</span>
      </summary>
      <div className="employeeUpdateList">
        {latestMessages.map((message) => <MessageDisclosure key={message.id} message={message} business={session.business} />)}
        {!latestMessages.length && <p className="empEmpty">No recent updates.</p>}
        <button type="button" className="employeeInlineButton" onClick={() => setTab("messages")}>Open all messages</button>
      </div>
    </details>

    <nav className="employeeTabs" aria-label="Employee Hub sections">
      {(["schedule", "messages", "requests", "time", "availability"] as Tab[]).map((name) => (
        <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>
          {name === "time" ? "Time & corrections" : name[0].toUpperCase() + name.slice(1)}
        </button>
      ))}
    </nav>

    {tab === "schedule" && <section className="employeeGrid">
      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Assigned</p><h2>My schedule</h2></div></div>
        <div className="employeeList">
          {myShifts.map((shift) => <div className="employeeShift" key={shift.id}>
            <div><strong>{shift.position || session.position}</strong><span>{local(shift.startsAt)} to {localTime(shift.endsAt)}</span>{shift.notes && <small>{shift.notes}</small>}</div>
            <button disabled={busy} onClick={() => void action({ action: "shift-request", requestType: "Offer", shiftId: shift.id }, "Shift offered for manager approval.")}>Offer shift</button>
          </div>)}
          {myShifts.length === 0 && <p className="empEmpty">No upcoming assigned shifts.</p>}
        </div>
      </article>

      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Available</p><h2>Open shifts</h2></div></div>
        <div className="employeeList">
          {openShifts.map((shift) => <div className="employeeShift" key={shift.id}>
            <div><strong>{shift.position || "Open shift"}</strong><span>{local(shift.startsAt)} to {localTime(shift.endsAt)}</span></div>
            <button disabled={busy} onClick={() => void action({ action: "shift-request", requestType: "Claim", shiftId: shift.id }, "Claim request sent to management.")}>Request shift</button>
          </div>)}
          {openShifts.length === 0 && <p className="empEmpty">No open shifts.</p>}
        </div>
      </article>

      <article className="employeeCard employeeWide teamWeekCard">
        <div className="employeeCardHeader teamWeekHeader">
          <div><p className="empEyebrow">Published</p><h2>Team schedule</h2><span>{weekLabel}</span></div>
          <div className="weekControls">
            <button type="button" onClick={() => setWeekOffset((value) => value - 1)}>Previous</button>
            <button type="button" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>This week</button>
            <button type="button" onClick={() => setWeekOffset((value) => value + 1)}>Next</button>
          </div>
        </div>
        <div className="teamWeekScroll">
          <div className="teamWeekGrid">
            {scheduleDays.map((day) => {
              const dayKey = localDateKey(day);
              const dayShifts = (data?.teamShifts || []).filter((shift) => localDateKey(shift.startsAt) === dayKey);
              const today = dayKey === localDateKey(new Date());
              return <section className={`teamDay ${today ? "today" : ""}`} key={dayKey}>
                <header><strong>{shortWeekdays[day.getDay()]}</strong><span>{day.toLocaleDateString([], { month: "short", day: "numeric" })}</span></header>
                <div className="teamDayShifts">
                  {dayShifts.map((shift) => <article
                    className={`teamShiftTile ${shift.employeeId === session.employeeId ? "mine" : !shift.employeeId ? "openShift" : ""}`}
                    key={shift.id}
                  >
                    <strong>{shift.employeeName || "OPEN"}</strong>
                    <span>{localTime(shift.startsAt)} – {localTime(shift.endsAt)}</span>
                    <small>{shift.position || "Shift"}</small>
                  </article>)}
                  {!dayShifts.length && <span className="teamDayEmpty">No shifts</span>}
                </div>
              </section>;
            })}
          </div>
        </div>
      </article>
    </section>}

    {tab === "messages" && <section className="employeeMessageWorkspace">
      <details className="employeeDisclosure employeeComposeDisclosure">
        <summary><strong>Send a message</strong><span>Team or direct message</span></summary>
        <form className="employeeForm employeeDisclosureBody" onSubmit={sendMessage}>
          <label>
            Recipient
            <select name="recipientEmployeeId" defaultValue="">
              <option value="">Everyone at {session.business}</option>
              {(data?.directory || []).filter((person) => person.id !== session.employeeId).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
          <label>Message<textarea name="body" rows={4} required /></label>
          <button disabled={busy}>Send</button>
        </form>
      </details>

      <article className="employeeCard employeeMessageCard">
        <div className="employeeCardHeader">
          <div><p className="empEyebrow">Recent</p><h2>Messages and updates</h2></div>
          <strong className="employeeMessageTotal">{data?.messages.length || 0}</strong>
        </div>
        <div className="employeeMessageList">
          {(data?.messages || []).map((message) => <MessageDisclosure key={message.id} message={message} business={session.business} />)}
          {!data?.messages.length && <p className="empEmpty">No messages yet.</p>}
        </div>
      </article>
    </section>}

    {tab === "requests" && <section className="employeeGrid">
      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Trade assigned shifts</p><h2>Request a swap</h2></div></div>
        <form className="employeeForm" onSubmit={requestSwap}>
          <label>My shift<select name="shiftId" required><option value="">Choose shift</option>{myShifts.map((shift) => <option key={shift.id} value={shift.id}>{local(shift.startsAt)} · {shift.position}</option>)}</select></label>
          <label>Other employee&apos;s shift<select name="offeredShiftId" required><option value="">Choose shift</option>{otherShifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.employeeName} · {local(shift.startsAt)} · {shift.position}</option>)}</select></label>
          <label>Note<textarea name="note" rows={3} /></label>
          <button disabled={busy}>Send swap request</button>
        </form>
      </article>

      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Action needed</p><h2>Incoming requests</h2></div></div>
        <div className="employeeList">
          {incomingRequests.map((request) => <div className="employeeRequest" key={request.id}>
            <div><strong>{request.requester_name} requested a {request.request_type.toLowerCase()}</strong><span>{local(request.starts_at)} · {request.position}</span>{request.note && <p>{request.note}</p>}</div>
            <div>
              <button disabled={busy} onClick={() => void action({ action: "shift-response", id: request.id, accept: true }, "Shift request accepted and sent to management.")}>Accept</button>
              <button className="empSecondary" disabled={busy} onClick={() => void action({ action: "shift-response", id: request.id, accept: false }, "Shift request declined.")}>Decline</button>
            </div>
          </div>)}
          {!incomingRequests.length && <p className="empEmpty">No incoming requests.</p>}
        </div>
      </article>

      <article className="employeeCard employeeWide">
        <div className="employeeCardHeader"><div><p className="empEyebrow">History</p><h2>My shift requests</h2></div></div>
        <div className="employeeList">
          {(data?.shiftRequests || []).map((request) => <div className="employeeHistory" key={request.id}>
            <strong>{request.request_type} · {request.status}</strong><span>{local(request.starts_at)} · {request.position}</span>{request.note && <p>{request.note}</p>}
          </div>)}
          {!data?.shiftRequests.length && <p className="empEmpty">No shift requests yet.</p>}
        </div>
      </article>
    </section>}

    {tab === "time" && <section className="employeeGrid">
      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Fix a punch</p><h2>Request a time correction</h2></div></div>
        <form className="employeeForm" onSubmit={requestCorrection}>
          <label>Time record<select name="sourceId" required><option value="">Choose record</option>{(data?.recentTime || []).map((record) => <option key={record.id} value={record.id}>{local(record.clock_in || record.clock_out)} · {record.position}</option>)}</select></label>
          <label>Correct clock-in<input name="requestedClockIn" type="datetime-local" /></label>
          <label>Correct clock-out<input name="requestedClockOut" type="datetime-local" /></label>
          <label>Reason<textarea name="reason" rows={3} required /></label>
          <button disabled={busy}>Submit correction</button>
        </form>
      </article>

      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Recent</p><h2>Time records</h2></div></div>
        <div className="employeeList">
          {(data?.recentTime || []).map((record) => <div className="employeeHistory" key={record.id}>
            <strong>{record.position || "Shift"} · {record.status}</strong>
            <span>{local(record.clock_in)} to {record.clock_out ? local(record.clock_out) : "Missing clock-out"}</span>
            {record.reported_hours !== undefined && <small>{Number(record.reported_hours || 0).toFixed(2)} reported hours</small>}
          </div>)}
          {!data?.recentTime.length && <p className="empEmpty">No recent time records.</p>}
        </div>
      </article>

      <article className="employeeCard employeeWide">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Review status</p><h2>Correction requests</h2></div></div>
        <div className="employeeList">
          {(data?.corrections || []).map((correction) => <div className="employeeHistory" key={correction.id}>
            <strong>{correction.status} · {correction.source_type}</strong><span>{local(correction.created_at)}</span><p>{correction.reason}</p>
            <small>{inputDateTime(correction.requested_clock_in)} to {inputDateTime(correction.requested_clock_out)}</small>
          </div>)}
          {!data?.corrections.length && <p className="empEmpty">No correction requests.</p>}
        </div>
      </article>
    </section>}

    {tab === "availability" && <section className="employeeGrid">
      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Weekly availability</p><h2>Update a weekday</h2></div></div>
        <form className="employeeForm" onSubmit={saveAvailability}>
          <label>Weekday<select name="weekday">{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
          <label>Available<select name="available"><option value="yes">Yes</option><option value="no">No</option></select></label>
          <label>From<input name="availableFrom" type="time" /></label>
          <label>To<input name="availableTo" type="time" /></label>
          <label>Notes<textarea name="notes" rows={3} /></label>
          <button disabled={busy}>Save availability</button>
        </form>
      </article>

      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Days away</p><h2>Request time off</h2></div></div>
        <form className="employeeForm" onSubmit={requestDaysOff}>
          <label>Starts<input name="startsOn" type="date" required /></label>
          <label>Ends<input name="endsOn" type="date" required /></label>
          <label>Reason<textarea name="reason" rows={3} /></label>
          <button disabled={busy}>Submit time-off request</button>
        </form>
      </article>

      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Current</p><h2>Availability</h2></div></div>
        <div className="availabilitySummary">
          {weekdays.map((day, index) => {
            const availability = data?.availability.find((item) => item.weekday === index);
            return <div key={day}><strong>{day}</strong><span>{availability ? availability.available ? `${availability.available_from || "Any"} – ${availability.available_to || "Any"}` : "Unavailable" : "Not set"}</span></div>;
          })}
        </div>
      </article>

      <article className="employeeCard">
        <div className="employeeCardHeader"><div><p className="empEyebrow">Status</p><h2>Time-off requests</h2></div></div>
        <div className="employeeList">
          {(data?.timeOff || []).map((item) => <div className="employeeHistory" key={item.id}>
            <strong>{item.status}</strong><span>{item.starts_on} through {item.ends_on}</span>{item.reason && <p>{item.reason}</p>}
          </div>)}
          {!data?.timeOff.length && <p className="empEmpty">No time-off requests.</p>}
        </div>
      </article>
    </section>}
  </main>;
}

"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import ScheduleBoard, { type ScheduleEmployee, type ScheduleShift, type ScheduleTimeOff } from "./schedule-board";
import WeekCopyPanel from "./week-copy-panel";
import "./workforce.css";

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
type TimeOff = ScheduleTimeOff & {
  reason: string;
  employee_name: string;
  starts_on: string;
  ends_on: string;
  created_at: string;
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
  employees: ScheduleEmployee[];
  shifts: ScheduleShift[];
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
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return "Invalid date";
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleDateString([], {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function newYorkDateKey(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function timeOffShiftConflicts(request: TimeOff, shifts: ScheduleShift[]) {
  return shifts.filter((shift) => {
    if (shift.status === "Cancelled" || shift.employeeId !== request.employee_id) return false;
    const shiftStart = newYorkDateKey(shift.startsAt);
    const endInstant = new Date(Math.max(new Date(shift.startsAt).getTime(), new Date(shift.endsAt).getTime() - 1));
    const shiftEnd = newYorkDateKey(endInstant);
    return request.starts_on <= shiftEnd && request.ends_on >= shiftStart;
  });
}

function firstName(value: string | null) {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
  if (text.toLowerCase() === "crfrary@gmail.com") return "Chris";
  const candidate = text.includes("@")
    ? text.split("@")[0].split(/[._-]/)[0]
    : text.split(/\s+/)[0];
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

export default function WorkforcePage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<WorkforceData | null>(null);
  const [tab, setTab] = useState<Tab>("schedule");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const loadSequence = useRef(0);
  const businessRef = useRef<Business>(business);
  businessRef.current = business;

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach server"] }));
  }, []);

  async function load(activeBusiness = businessRef.current, signal?: AbortSignal) {
    const requestId = ++loadSequence.current;
    const response = await fetch(`/api/workforce?business=${encodeURIComponent(activeBusiness)}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as WorkforceData;
    if (requestId === loadSequence.current && businessRef.current === activeBusiness) {
      setData(payload);
    }
    return payload;
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    const activeBusiness = business;
    const controller = new AbortController();
    setData(null);
    setNotice("");
    void load(activeBusiness, controller.signal).catch((error) => {
      if ((error as Error)?.name === "AbortError") return;
      if (businessRef.current === activeBusiness) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business]);

  async function action(body: Record<string, unknown>, success: string) {
    const actionBusiness = businessRef.current;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/workforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, business: actionBusiness }),
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) throw new Error(String(payload?.error || `Request failed (${response.status}).`));
      if (businessRef.current === actionBusiness) {
        await load(actionBusiness);
        if (businessRef.current === actionBusiness) {
          const email = payload?.email as { configured?: boolean; sent?: number; failed?: number; missingEmail?: number } | undefined;
          const sms = payload?.sms as { configured?: boolean; sent?: number; failed?: number; missingPhone?: number; notOptedIn?: number } | undefined;
          const duplicate = Boolean(payload?.duplicate);
          const delivery = email || sms
            ? [
                email ? `Email ${email.configured === false ? "not configured" : `${email.sent || 0} sent, ${email.failed || 0} failed, ${email.missingEmail || 0} missing`}` : "",
                sms ? `SMS ${sms.configured === false ? "not configured" : `${sms.sent || 0} sent, ${sms.failed || 0} failed, ${sms.missingPhone || 0} missing, ${sms.notOptedIn || 0} opted out`}` : "",
              ].filter(Boolean).join(" · ")
            : "";
          setNotice(`${duplicate ? "Schedule publish already processed." : success}${delivery ? ` ${delivery}.` : ""}`);
        }
      }
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The operation failed.";
      if (businessRef.current === actionBusiness) setNotice(message);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function approveTimeOff(request: TimeOff) {
    const actionBusiness = businessRef.current;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/workforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "time-off-review", business: actionBusiness, id: request.id, approve: true }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; requiresReassignment?: boolean; conflictingShifts?: unknown[]; employeeName?: string } | null;
      if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
      if (businessRef.current === actionBusiness) {
        await load(actionBusiness);
        if (businessRef.current === actionBusiness) {
          const count = payload?.conflictingShifts?.length || 0;
          setNotice(payload?.requiresReassignment
            ? `Time off approved. ${payload.employeeName || request.employee_name} is already assigned to ${count} conflicting shift${count === 1 ? "" : "s"}. Reassign or open ${count === 1 ? "that shift" : "those shifts"} before publishing/resending.`
            : "Time off approved.");
        }
      }
    } catch (error) {
      if (businessRef.current === actionBusiness) setNotice(error instanceof Error ? error.message : "Time off could not be approved.");
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
    }, "Message sent.").catch(() => undefined);
    formElement.reset();
  }

  const currentData = data?.business === business ? data : null;
  const activeEmployees = currentData?.employees.filter((employee) => employee.active) || [];
  const pendingRequests = currentData?.shiftRequests.filter((request) => request.status === "Pending") || [];
  const pendingCorrections = currentData?.corrections.filter((request) => request.status === "Pending") || [];
  const pendingTimeOff = currentData?.timeOff.filter((request) => request.status === "Pending") || [];
  const upcomingShifts = currentData?.shifts.filter((shift) => shift.status !== "Cancelled" && new Date(shift.endsAt).getTime() >= Date.now()).length || 0;

  if (!session) return <main className="workforceShell"><div className="workforcePanel"><h1>Loading workforce</h1></div></main>;
  if (!session.authenticated) return <main className="workforceShell"><div className="workforcePanel"><h1>Owner access required</h1><a className="wfPrimary" href="/">Return to sign-in</a></div></main>;

  return <main className="workforceShell">
    <header className="workforceHero">
      <div>
        <p className="wfEyebrow">People, schedules, and corrections</p>
        <h1>Workforce Admin</h1>
        <p>Build the Monday-through-Sunday schedule, drag shifts between employees, copy individual shifts or entire historical weeks, publish instructions, and review staff requests.</p>
      </div>
      <div className="wfBusinessSwitch">
        {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button
          key={name}
          className={business === name ? "selected" : ""}
          onClick={() => {
            if (name === businessRef.current) return;
            businessRef.current = name;
            loadSequence.current += 1;
            setData(null);
            setNotice("");
            setBusiness(name);
          }}
        >{name}</button>)}
      </div>
    </header>

    {notice && <div className="wfNotice">{notice}</div>}

    <section className="wfStats">
      <article><span>Active employees</span><strong>{activeEmployees.length}</strong></article>
      <article><span>Upcoming shifts</span><strong>{upcomingShifts}</strong></article>
      <article><span>Shift requests</span><strong>{pendingRequests.length}</strong></article>
      <article><span>Corrections</span><strong>{pendingCorrections.length}</strong></article>
      <article><span>Time off</span><strong>{pendingTimeOff.length}</strong></article>
    </section>

    <nav className="wfTabs">
      {(["schedule", "messages", "requests", "corrections", "availability"] as Tab[]).map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name === "availability" ? "Availability & time off" : name[0].toUpperCase() + name.slice(1)}</button>)}
    </nav>

    {tab === "schedule" && <>
      <WeekCopyPanel
        key={`copy-${business}`}
        business={business}
        shifts={currentData?.shifts || []}
        busy={busy}
        runAction={action}
      />
      <ScheduleBoard
        key={`schedule-${business}`}
        business={business}
        employees={activeEmployees}
        shifts={currentData?.shifts || []}
        timeOff={currentData?.timeOff || []}
        busy={busy}
        runAction={action}
      />
    </>}

    {tab === "messages" && <section className="wfTwoColumn" key={`messages-${business}`}>
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Team communication</p><h2>Send a message</h2></div></div>
        <form className="wfForm oneColumn" onSubmit={sendMessage}>
          <label>Recipient<select name="recipientEmployeeId" defaultValue=""><option value="">Everyone at {business}</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{firstName(employee.name)}</option>)}</select></label>
          <label>Message<textarea name="body" rows={6} required /></label>
          <button className="wfPrimary" disabled={busy}>Send</button>
        </form>
      </article>
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Recent</p><h2>Message board</h2></div></div>
        <div className="wfList">{(currentData?.messages || []).map((message) => <div className="wfMessage" key={message.id}><div><strong>{firstName(message.sender_name)}</strong><span>{message.recipient_name ? `to ${firstName(message.recipient_name)}` : message.message_type}</span></div><p>{message.body}</p><small>{local(message.created_at)}</small></div>)}{!currentData?.messages.length && <p className="wfEmpty">No messages yet.</p>}</div>
      </article>
    </section>}

    {tab === "requests" && <section className="wfTwoColumn" key={`requests-${business}`}>
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Claims, offers, and swaps</p><h2>Shift requests</h2></div></div>
        <div className="wfList">{(currentData?.shiftRequests || []).map((request) => <div className="wfRequest" key={request.id}><div><strong>{request.request_type}: {request.requester_name}</strong><span>{request.target_name ? `with ${request.target_name}` : "Manager review"}</span><small>{local(request.starts_at)} · {request.position}</small>{request.note && <p>{request.note}</p>}<small>Employee response: {request.employee_response}</small></div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void action({ action: "shift-request-review", id: request.id, approve: true }, "Shift request approved.").catch(() => undefined)}>Approve</button><button disabled={busy} onClick={() => void action({ action: "shift-request-review", id: request.id, approve: false }, "Shift request rejected.").catch(() => undefined)}>Reject</button></>}</div></div>)}{!currentData?.shiftRequests.length && <p className="wfEmpty">No shift requests.</p>}</div>
      </article>
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Requested days away</p><h2>Time off</h2></div></div>
        <div className="wfList">{(currentData?.timeOff || []).map((request) => {
          const conflicts = timeOffShiftConflicts(request, currentData?.shifts || []);
          return <div className="wfRequest" key={request.id}><div><strong>{request.employee_name}</strong><span>{dateOnly(request.starts_on)} through {dateOnly(request.ends_on)}</span><small>Submitted {local(request.created_at)} via Employee Hub</small>{request.reason && <p>{request.reason}</p>}{conflicts.length > 0 && <p className="wfTimeOffConflict"><strong>Schedule conflict:</strong> already assigned to {conflicts.map((shift) => `${local(shift.startsAt)}–${new Date(shift.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`).join("; ")}. {request.status === "Pending" ? "Approving this request will require reassignment." : request.status === "Approved" ? "Reassign or open the conflicting shift." : ""}</p>}</div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void approveTimeOff(request)}>Approve</button><button disabled={busy} onClick={() => void action({ action: "time-off-review", id: request.id, approve: false }, "Time off rejected.").catch(() => undefined)}>Reject</button></>}</div></div>;
        })}{!currentData?.timeOff.length && <p className="wfEmpty">No time-off requests.</p>}</div>
      </article>
    </section>}

    {tab === "corrections" && <section className="workforcePanel" key={`corrections-${business}`}>
      <div className="wfPanelHeader"><div><p className="wfEyebrow">Source-aware review</p><h2>Time clock corrections</h2></div><span className="wfSourceNote">{business === "Tiki" ? "Corner Ops punches" : "Rezku imported shifts"}</span></div>
      <div className="wfList">{(currentData?.corrections || []).map((request) => <div className="wfCorrection" key={request.id}><div><strong>{request.employee_name} · {request.source_type}</strong><span>Original: {local(request.original_clock_in)} to {local(request.original_clock_out)}</span><span>Requested: {local(request.requested_clock_in)} to {local(request.requested_clock_out)}</span><p>{request.reason}</p></div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void action({ action: "time-correction-review", id: request.id, approve: true }, "Correction approved and applied.").catch(() => undefined)}>Approve & apply</button><button disabled={busy} onClick={() => void action({ action: "time-correction-review", id: request.id, approve: false }, "Correction rejected.").catch(() => undefined)}>Reject</button></>}</div></div>)}{!currentData?.corrections.length && <p className="wfEmpty">No correction requests.</p>}</div>
    </section>}

    {tab === "availability" && <section className="workforcePanel" key={`availability-${business}`}>
      <div className="wfPanelHeader"><div><p className="wfEyebrow">Recurring weekly preferences</p><h2>Employee availability</h2></div></div>
      <div className="wfAvailabilityGrid">{activeEmployees.map((employee) => <article key={employee.id}><h3>{employee.name}</h3>{weekdays.map((day, index) => { const row = currentData?.availability.find((item) => item.employee_name === employee.name && item.weekday === index); return <div key={day}><strong>{day.slice(0, 3)}</strong><span>{row ? row.available ? `${row.available_from || "Any"} to ${row.available_to || "Any"}` : "Unavailable" : "Not set"}</span></div>; })}</article>)}</div>
    </section>}
  </main>;
}

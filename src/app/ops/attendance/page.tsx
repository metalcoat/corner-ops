"use client";

import { useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./attendance.css";

type AttendanceCase = {
  id: string;
  business: Business;
  employeeName: string;
  employeeEmail: string;
  position: string;
  scheduledStart: string;
  scheduledEnd: string;
  correctionStart: string | null;
  correctionEnd: string | null;
  employeeNote: string;
  submissionChannel: string;
  status: string;
  notifiedAt: string | null;
  notificationError: string;
  managerNote: string;
};

type Payload = {
  business: Business;
  counts: { awaitingReply: number; submitted: number; approved: number; unresolvedEmail: number };
  cases: AttendanceCase[];
};

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function local(value: string | null) {
  if (!value) return "Not provided";
  return new Date(value).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function AttendancePage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Tiki");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: SessionView) => {
        setSession(value);
        const allowed = value.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setNotice("Unable to load the current account."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/attendance?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Payload);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  async function review(item: AttendanceCase, approve: boolean) {
    const managerNote = window.prompt(approve ? "Optional approval note" : "Reason for rejecting this correction", item.managerNote || "") ?? "";
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review", business, id: item.id, approve, managerNote }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(approve ? "Correction approved and time record created." : "Correction rejected and returned to the employee.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Attendance review failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage">Loading attendance review…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  return <main className="controlPage">
    <header className="controlHeader"><div><p className="eyebrow">Attendance exceptions</p><h1>{business} missed shifts</h1><p>Employees can reply by email or submit exact corrected times through Employee Hub. Nothing reaches payroll until you approve it.</p></div><div className="controlActions"><div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><button disabled={busy} onClick={() => void load()}>Refresh</button><a href="/ops/workforce">Workforce</a></div></header>
    {notice && <div className="noticeBar">{notice}</div>}
    <div className="controlGrid">
      <section className="controlCard"><div className="attendanceStats"><article><span>Awaiting employee</span><strong>{data?.counts.awaitingReply || 0}</strong></article><article><span>Submitted</span><strong>{data?.counts.submitted || 0}</strong></article><article><span>Approved</span><strong>{data?.counts.approved || 0}</strong></article><article><span>Email issues</span><strong>{data?.counts.unresolvedEmail || 0}</strong></article></div></section>
      <section className="controlCard"><div className="attendanceList">{(data?.cases || []).map((item) => <article className={`attendanceCase ${item.status.toLowerCase().replaceAll(" ", "-")}`} key={item.id}><header><div><strong>{item.employeeName}</strong><span>{item.position} · {item.status}</span></div><small>{item.submissionChannel || "No response yet"}</small></header><div className="attendanceTimes"><div><span>Scheduled</span><strong>{local(item.scheduledStart)}</strong><small>to {local(item.scheduledEnd)}</small></div><div><span>Employee correction</span><strong>{local(item.correctionStart)}</strong><small>to {local(item.correctionEnd)}</small></div></div>{item.employeeNote && <blockquote>{item.employeeNote}</blockquote>}<div className="attendanceMeta"><span>{item.employeeEmail || "Email missing"}</span><span>{item.notifiedAt ? `Emailed ${local(item.notifiedAt)}` : item.notificationError || "Email not sent"}</span></div>{item.status === "Submitted" && <div className="attendanceActions"><button disabled={busy} onClick={() => void review(item, true)}>Approve & create time</button><button className="danger" disabled={busy} onClick={() => void review(item, false)}>Reject</button></div>}</article>)}{!data?.cases.length && <p>No missed-shift cases for this business.</p>}</div></section>
    </div>
  </main>;
}

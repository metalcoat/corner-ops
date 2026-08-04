"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./direct-deposit.css";

type Employee = { id: string; name: string; position: string };
type Summary = {
  id: string;
  employeeId: string;
  employeeName: string;
  status: "Assigned" | "Completed" | "Superseded";
  assignedAt: string;
  signedAt: string | null;
};
type Detail = Summary & { payload: Record<string, unknown> };
type PageData = { business: Business; employees: Employee[]; elections: Summary[] };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value ? value as Record<string, unknown> : {};
}

function display(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function label(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

export default function DirectDepositAdminPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<PageData | null>(null);
  const [review, setReview] = useState<Detail | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => {
        setSession(payload);
        const allowed = payload.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setSession({ authenticated: false } as SessionView));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/direct-deposit?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as PageData);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setReview(null);
    setNotice("");
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/direct-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "assign", business, employeeId: form.get("employeeId") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice("Direct-deposit and payment-method election assigned in Employee Hub.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Direct-deposit form could not be assigned.");
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    setNotice("");
    const response = await fetch(`/api/direct-deposit?business=${encodeURIComponent(business)}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as { election: Detail };
    setReview(payload.election);
  }

  const allowedBusinesses = session?.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);
  const completed = useMemo(() => data?.elections.filter((item) => item.status === "Completed").length || 0, [data?.elections]);
  const pending = useMemo(() => data?.elections.filter((item) => item.status === "Assigned").length || 0, [data?.elections]);
  const submission = record(review?.payload.employeeSubmission);

  if (!session) return <main className="controlPage">Loading direct-deposit records…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage ddAdminPage">
    <header className="controlHeader"><div><p className="eyebrow">Encrypted payroll banking onboarding</p><h1>{business} direct deposit</h1><p>Assign voluntary payment-method elections, review signed bank details, and copy the information into payroll without storing it in ordinary employee screens.</p></div><div className="controlActions"><div className="businessPills">{allowedBusinesses.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><a href="/ops/employment-forms">Employment forms</a></div></header>
    {notice && <div className="noticeBar">{notice}</div>}
    {!data && <section className="controlCard">Loading records…</section>}
    {data && <>
      <section className="ddAdminStats"><article><span>Active employees</span><strong>{data.employees.length}</strong></article><article><span>Awaiting signature</span><strong>{pending}</strong></article><article><span>Completed elections</span><strong>{completed}</strong></article></section>
      <section className="ddAdminGrid">
        <article className="controlCard"><p className="eyebrow">Assign or replace</p><h2>Direct-deposit election</h2><p className="ddHelp">Assigning another form supersedes only an unsigned form. Prior signed elections remain preserved.</p><form className="ddAdminForm" onSubmit={assign}><label>Employee<select name="employeeId" required><option value="">Choose employee</option>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.position}</option>)}</select></label><button disabled={busy}>Assign form</button></form></article>
        <article className="controlCard ddSecurity"><p className="eyebrow">Handling rule</p><h2>Confidential payroll data</h2><p>Routing and account numbers are encrypted at rest and shown only in this authenticated review. Enter them directly into payroll, avoid screenshots, and do not paste them into messages or general documents.</p></article>
      </section>
      <section className="controlCard ddRecords"><div className="ddRecordsHeader"><div><p className="eyebrow">Payment elections</p><h2>Employee records</h2></div><span>{data.elections.length} total</span></div><div className="tableWrap"><table><thead><tr><th>Employee</th><th>Status</th><th>Assigned</th><th>Signed</th><th>Action</th></tr></thead><tbody>{data.elections.map((item) => <tr key={item.id}><td>{item.employeeName}</td><td><span className={`ddStatus ${item.status.toLowerCase()}`}>{item.status}</span></td><td>{new Date(item.assignedAt).toLocaleString()}</td><td>{item.signedAt ? new Date(item.signedAt).toLocaleString() : "—"}</td><td><button disabled={busy} onClick={() => void open(item.id)}>Review</button></td></tr>)}{!data.elections.length && <tr><td colSpan={5}>No direct-deposit elections yet.</td></tr>}</tbody></table></div></section>
      {review && <section className="controlCard ddReview"><div className="ddRecordsHeader"><div><p className="eyebrow">Secure record</p><h2>{review.employeeName}</h2><p>{review.status} · assigned {new Date(review.assignedAt).toLocaleString()}</p></div><button onClick={() => setReview(null)}>Close</button></div>
        <div className="ddReviewGrid">{Object.entries(submission).map(([key, value]) => <div key={key}><span>{label(key)}</span><strong>{display(value)}</strong></div>)}{!Object.keys(submission).length && <p>The employee has not submitted this form yet.</p>}</div>
        {review.status === "Completed" && <button className="ddPrint" type="button" onClick={() => window.print()}>Print secure payroll copy</button>}
      </section>}
    </>}
  </main>;
}

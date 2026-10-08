"use client";

import { responseMessage } from "@/app/client-http";
import { useSiteBrand } from "@/app/brand-context";
import { FormEvent, useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../../control-center.css";

type ClockOutCase = {
  id: string;
  business: Business;
  employeeName: string;
  position: string;
  clockIn: string | null;
  clockInEastern: string | null;
  businessDate: string;
  closeBasisLabel: string;
  scheduledEnd: string | null;
  scheduledEndEastern: string | null;
  status: "Open" | "Submitted" | "Resolved";
  employeeLeftAt: string | null;
  employeeLeftAtEastern: string | null;
  employeeNote: string;
  smsLabel: string;
  resolution: string;
  resolvedClockOutEastern: string | null;
  resolvedBy: string;
};

const EASTERN_TIME_ZONE = "America/New_York";

function easternInputValue(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function weekStartFor(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const RESOLUTIONS: Record<string, string> = {
  scheduled_end: "Scheduled end used",
  employee_time: "Employee's time used",
  custom: "Time entered by owner",
  closed_elsewhere: "Closed on the punch itself",
};

export default function MissedClockOutsPage() {
  const brand = useSiteBrand();
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>(brand.name === "At the Docks" ? "Tiki" : "Corner Deli");
  const [focusId, setFocusId] = useState("");
  const [focused, setFocused] = useState<ClockOutCase | null>(null);
  const [cases, setCases] = useState<ClockOutCase[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setFocusId(params.get("case") || "");
    const requested = params.get("business");
    if (requested === "Corner Deli" || requested === "Tiki") setBusiness(requested);
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setNotice("Unable to load the current account."));
  }, []);

  async function load(activeBusiness = business, activeFocus = focusId) {
    let listBusiness = activeBusiness;
    if (activeFocus) {
      const response = await fetch(`/api/payroll-control?clockOutCase=${encodeURIComponent(activeFocus)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { case: ClockOutCase };
      setFocused(payload.case);
      listBusiness = payload.case.business;
      if (listBusiness !== activeBusiness) setBusiness(listBusiness);
    } else {
      setFocused(null);
    }
    const response = await fetch(`/api/payroll-control?clockOuts=1&business=${encodeURIComponent(listBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as { cases: ClockOutCase[] };
    setCases(payload.cases);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business, focusId]);

  async function apply(item: ClockOutCase, choice: "scheduled_end" | "employee_time" | "custom", customTime?: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/payroll-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clock-out-apply", business: item.business, id: item.id, choice, customTime }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as { case: ClockOutCase | null };
      setNotice(`${item.employeeName} clocked out at ${result.case?.resolvedClockOutEastern || "the chosen time"}. Payroll uses this correction now.`);
      await load(item.business, focusId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function custom(item: ClockOutCase) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get("clockOut") || "");
      if (value) void apply(item, "custom", value);
    };
  }

  if (!session) return <main className="controlPage">Loading missed clock-outs…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href={`/signin?returnTo=${encodeURIComponent("/ops/payroll-control/clock-outs")}`}>Sign in to Corner Ops</a></main>;

  const others = cases.filter((item) => item.id !== focused?.id && item.status !== "Resolved");
  const card = (item: ClockOutCase) => <section className="controlCard" key={item.id}>
    <p className="eyebrow">{item.business} · {item.position || "Shift"} · {item.status === "Submitted" ? "Employee entered a time" : item.status}</p>
    <h2>{item.employeeName}</h2>
    <div className="metricGrid">
      <div className="metric"><span>Clocked in</span><strong>{item.clockInEastern || "—"}</strong></div>
      <div className="metric"><span>Scheduled end</span><strong>{item.scheduledEndEastern || "No published shift"}</strong></div>
      <div className="metric"><span>They say they left</span><strong>{item.employeeLeftAtEastern || "Not entered yet"}</strong></div>
    </div>
    {item.employeeNote && <p className="reportNote">“{item.employeeNote}”</p>}
    <p className="reportNote">{item.smsLabel}. Found after {item.closeBasisLabel}.</p>
    {item.status === "Resolved"
      ? <p className="reportNote"><span className="badge good">{RESOLUTIONS[item.resolution] || "Settled"}</span> Clock-out {item.resolvedClockOutEastern || "saved"}{item.resolvedBy ? ` by ${item.resolvedBy}` : ""}.</p>
      : <>
        <div className="controlActions">
          {item.employeeLeftAt && <button className="primary" disabled={busy} onClick={() => void apply(item, "employee_time")}>Use the time they entered ({item.employeeLeftAtEastern})</button>}
          {item.scheduledEnd && <button className={item.employeeLeftAt ? "" : "primary"} disabled={busy} onClick={() => void apply(item, "scheduled_end")}>Use scheduled end ({item.scheduledEndEastern})</button>}
        </div>
        <form key={`${item.id}-${item.employeeLeftAt}`} className="controlForm" onSubmit={custom(item)}>
          <label>Another clock-out (ET)<input name="clockOut" type="datetime-local" defaultValue={easternInputValue(item.employeeLeftAt || item.scheduledEnd)} required /></label>
          <div className="controlActions"><button disabled={busy}>Use this time</button></div>
        </form>
        <p className="reportNote">Saved as an audited punch correction; it closes the open punch and settles this case.</p>
      </>}
    <p><a href={`/ops/payroll-control?business=${encodeURIComponent(item.business)}&weekStart=${weekStartFor(item.businessDate)}`}>Open this payroll week</a></p>
  </section>;

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Payroll · Eastern Time</p>
        <h1>Missed clock-outs</h1>
        <p>Punches still open an hour after close. Choose the clock-out to use; nothing changes until you tap one.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills">{(["Corner Deli", "Tiki"] as Business[]).filter((name) => !session.businesses?.length || session.businesses.includes(name)).map((name) => <button key={name} className={business === name && !focusId ? "active" : ""} onClick={() => { setFocusId(""); setBusiness(name); }}>{name}</button>)}</div>
        <a href={`/ops/payroll-control?business=${encodeURIComponent(business)}`}>Payroll control</a>
      </div>
    </header>
    {notice && <div className="noticeBar">{notice}</div>}
    <div className="controlGrid">
      {focused && card(focused)}
      {others.map(card)}
      {!focused && !others.length && <section className="controlCard"><div className="emptyState">No open missed clock-outs for {business}.</div></section>}
    </div>
  </main>;
}

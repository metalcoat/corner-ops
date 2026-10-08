"use client";

import { responseMessage } from "@/app/client-http";
import { useSiteBrand } from "@/app/brand-context";
import { DEFAULT_PUNCH_CORRECTION_REASON, normalizePunchCorrectionReason } from "@/lib/punch-correction-reason";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import { payrollDisplayRows, showOvertimeColumn, type ScheduleComparison } from "@/lib/payroll-schedule-compare";
import "../control-center.css";

type PayrollRow = {
  employee: string;
  hours: number;
  regularHours: number;
  overtimeHours: number;
  driverTipHours: number;
  tipsBeforeFee?: number;
  pickupTipsBeforeFee?: number;
  deliveryTipsBeforeFee?: number;
  tips: number;
  pickupTips: number;
  deliveryTips: number;
  manualTips?: number;
};

type DailyTipCheck = {
  date: string;
  sourceTipsBeforeFee: number;
  deliveryTipsBeforeFee: number;
  pickupTipsBeforeFee: number;
  unclassifiedTipsBeforeFee: number;
  allocatedTipsBeforeFee: number;
  unallocatedTipsBeforeFee: number;
  feeAmount: number;
  expectedAfterFee: number;
  allocatedAfterFee: number;
  balance: number;
  status: string;
};

type Punch = {
  id: string;
  employeeName: string;
  position: string;
  clockIn: string | null;
  clockOut: string | null;
  clockInEastern?: string | null;
  clockOutEastern?: string | null;
  status: string;
  notes: string;
  source: string;
};

type Version = {
  id: string;
  weekStart: string;
  weekEnd: string;
  version: number;
  status: string;
  generatedBy: string;
  generatedAt: string;
  lockedBy: string | null;
  lockedAt: string | null;
};

type ClockOutCase = {
  id: string;
  employeeName: string;
  clockInEastern: string | null;
  scheduledEndEastern: string | null;
  employeeLeftAtEastern: string | null;
  status: string;
  smsLabel: string;
  resolvedClockOutEastern: string | null;
};

type Submission = {
  id: string;
  kind?: "payroll" | "roster";
  payrollRunVersionId: string | null;
  status: string;
  statusLine: string;
};

type PayrollRelief = {
  roster: Array<{ num: string; name: string; payType: string; display: string; lastSeenAt: string | null }>;
  people: Array<{ employee: string; inPayroll: boolean; active: boolean; eeNum: string | null; guessNum: string | null; guessReason: string }>;
  rosterCheck: Submission | null;
};

type Approval = {
  blockers: { openPunches: number; unresolvedClockOuts: number; needsReview: number; message: string | null };
  clockOutCases: ClockOutCase[];
  submissions: Submission[];
  sendsToPayrollRelief?: boolean;
  payrollRelief?: PayrollRelief | null;
};

type Dashboard = {
  approval?: Approval;
  summary: {
    source: string;
    processingFeeReviewCount?: number;
    weekStart: string;
    weekEnd: string;
    rows: PayrollRow[];
    overrides: Array<Record<string, unknown>>;
    unmatchedTips: Array<Record<string, unknown>>;
    dailyTipReconciliation?: DailyTipCheck[];
    scheduleComparison?: ScheduleComparison[];
  };
  punches: Punch[];
  versions: Version[];
  adjustments: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
};

const EASTERN_TIME_ZONE = "America/New_York";
const dollars = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
}).format(value || 0);
const hours = (value: number) => Number(value || 0).toFixed(2);

function previousMonday() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
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

function payrollDayLabel(value: string) {
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function easternDateTime(value: string | null | undefined, serverLabel?: string | null) {
  if (serverLabel) return serverLabel;
  if (!value) return "Open";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

function easternInputValue(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
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

export default function PayrollControlPage() {
  const brand = useSiteBrand();
  const siteBusiness: Business = brand.name === "At the Docks" ? "Tiki" : "Corner Deli";
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>(siteBusiness);
  const [weekStart, setWeekStart] = useState(previousMonday());
  const [dashboard, setDashboard] = useState<{ business: Business; weekStart: string; value: Dashboard } | null>(null);
  const requestId = useRef(0);
  const data = dashboard?.business === business && dashboard.weekStart === weekStart ? dashboard.value : null;
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Punch | null>(null);
  const [correctionReason, setCorrectionReason] = useState(DEFAULT_PUNCH_CORRECTION_REASON);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<Record<string, string>>({});

  useEffect(() => {
    // Links from the Monday payroll email open a business and week directly.
    const params = new URLSearchParams(window.location.search);
    const requestedBusiness = params.get("business");
    if (requestedBusiness === "Corner Deli" || requestedBusiness === "Tiki") setBusiness(requestedBusiness);
    const requestedWeek = params.get("weekStart");
    if (requestedWeek && /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek)) setWeekStart(requestedWeek);
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setNotice("Unable to load the current account."));
  }, []);

  async function load(activeBusiness = business, activeWeek = weekStart) {
    const currentRequest = ++requestId.current;
    const response = await fetch(
      `/api/payroll-control?business=${encodeURIComponent(activeBusiness)}&weekStart=${encodeURIComponent(activeWeek)}&displayVersion=20260804-3`,
      { cache: "no-store", headers: { "Cache-Control": "no-cache" } },
    );
    if (!response.ok) throw new Error(await responseMessage(response));
    const value = await response.json() as Dashboard;
    if (currentRequest === requestId.current) setDashboard({ business: activeBusiness, weekStart: activeWeek, value });
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    const activeRequest = requestId.current + 1;
    void load(business, weekStart).catch((error) => {
      if (activeRequest === requestId.current) setNotice(error instanceof Error ? error.message : String(error));
    });
    return () => { requestId.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business, weekStart]);

  // While the store server is entering payroll (or waiting for a texted code), keep the status current.
  const working = Boolean(data?.approval && [...data.approval.submissions, ...(data.approval.payrollRelief?.rosterCheck ? [data.approval.payrollRelief.rosterCheck] : [])]
    .some((item) => item.status === "submitting" || item.status === "needs_code" || item.status === "queued"));
  useEffect(() => {
    if (!working || !session?.authenticated) return;
    const timer = window.setInterval(() => { if (!busy) void load(business, weekStart).catch(() => undefined); }, 10_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, busy, business, weekStart, session?.authenticated]);

  // The dropdowns start at the saved match, else the best guess; the owner confirms with Save.
  const relief = data?.approval?.payrollRelief || null;
  useEffect(() => {
    if (!relief) return;
    setMatches(Object.fromEntries(relief.people.map((p) => [p.employee, p.eeNum || p.guessNum || ""])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(relief?.people), JSON.stringify(relief?.roster.map((r) => r.num))]);

  async function sendCode(submission: Submission) {
    const code = (codes[submission.id] || "").trim();
    if (!code) return;
    await post({ action: "submission-code", business, id: submission.id, code })
      .then(() => { setCodes((current) => ({ ...current, [submission.id]: "" })); setNotice("Code sent to the store server; it signs in within a few seconds."); })
      .catch(() => undefined);
  }

  function submissionControls(submission: Submission) {
    return <>
      {submission.status === "needs_code" && <span className="controlActions">
        <input aria-label="Code from the text" inputMode="numeric" autoComplete="one-time-code" placeholder="Code from the text" value={codes[submission.id] || ""} onChange={(event) => setCodes((current) => ({ ...current, [submission.id]: event.target.value }))} />
        <button className="primary" disabled={busy || !(codes[submission.id] || "").trim()} onClick={() => void sendCode(submission)}>Send code</button>
      </span>}
      {submission.kind !== "roster" && (submission.status === "failed" || submission.status === "submitted") && <> <button disabled={busy} onClick={() => void post({ action: "submission-retry", business, id: submission.id }).then(() => setNotice("Queued to enter in Payroll Relief again (saved, not submitted).")).catch(() => undefined)}>Send again</button></>}
    </>;
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/payroll-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json();
      await load(business, weekStart);
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function postTikiCorrection(body: Record<string, unknown>) {
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
      await load("Tiki", weekStart);
      return result as Record<string, unknown>;
    } catch (error) {
      setNotice(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function recalculate() {
    setBusy(true);
    setNotice("");
    try {
      await load(business, weekStart);
      setNotice("Payroll hours and tips recalculated from the current corrected shifts and tip overrides.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || busy) return;
    const form = new FormData(event.currentTarget);
    const clockIn = String(form.get("clockIn") || "");
    const clockOut = String(form.get("clockOut") || "");
    try {
      if (business === "Tiki") {
        const result = await postTikiCorrection({
          action: "correct",
          sourceId: editing.id,
          employeeName: form.get("employeeName"),
          position: form.get("position"),
          clockInWall: clockIn,
          clockOutWall: clockOut,
          reason: normalizePunchCorrectionReason(form.get("reason")),
        });
        const punch = result.punch as Record<string, unknown> | undefined;
        setEditing(null);
        setNotice(`Saved ${editing.employeeName}: ${String(punch?.clockInEastern || "clock-in saved")} to ${String(punch?.clockOutEastern || "Open")}. Payroll and the live Tiki clock now use this correction.`);
        return;
      }

      await post({
        action: "punch-correct",
        business,
        sourceType: "Rezku",
        sourceId: editing.id,
        employeeName: form.get("employeeName"),
        position: form.get("position"),
        clockInWall: clockIn,
        clockOutWall: clockOut,
        reason: normalizePunchCorrectionReason(form.get("reason")),
      });
      setEditing(null);
      setNotice("Shift corrected in Eastern Time. Payroll hours and tip allocation were recalculated immediately.");
    } catch {
      // post/postTikiCorrection already put the useful error on screen.
    }
  }

  async function tikiUseAsPriorOut(punch: Punch) {
    if (!window.confirm(`${punch.employeeName}: use ${easternDateTime(punch.clockIn, punch.clockInEastern)} as the previous shift's clock-out and zero this mistaken IN?`)) return;
    try {
      const result = await postTikiCorrection({ action: "use-in-as-prior-out", sourceId: punch.id });
      setEditing(null);
      setNotice(`Corrected ${punch.employeeName}: the mistaken IN became the prior shift's OUT. ${Number(result.staleOpenPunchesResolved || 0) ? `Also cleared ${Number(result.staleOpenPunchesResolved)} stale open punch(es).` : "The live clock state is reconciled."}`);
    } catch {
      // Error is already displayed by postTikiCorrection.
    }
  }

  async function tipOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await post({
      action: "tip-override-create",
      business,
      weekStart,
      sourceTransactionId: form.get("sourceTransactionId"),
      employeeName: form.get("employeeName"),
      amount: Number(form.get("amount") || 0),
      reason: form.get("reason"),
    });
    formElement.reset();
    setNotice("Tip override applied and payroll totals recalculated.");
  }

  const totals = useMemo(() => data?.summary.rows.reduce(
    (current, row) => ({
      hours: current.hours + row.hours,
      overtime: current.overtime + row.overtimeHours,
      tips: current.tips + row.tips,
    }),
    { hours: 0, overtime: 0, tips: 0 },
  ) || { hours: 0, overtime: 0, tips: 0 }, [data]);

  // Employee | Regular | Tipped | Tips | (OT when anyone has it) | Scheduled vs worked; scheduled-only employees included.
  const displayRows = useMemo(() => data ? payrollDisplayRows(data.summary.rows, data.summary.scheduleComparison || []) : [], [data]);
  const showOvertime = showOvertimeColumn(displayRows);

  const dailyTotals = useMemo(() => (data?.summary.dailyTipReconciliation || []).reduce(
    (current, day) => ({
      source: current.source + day.sourceTipsBeforeFee,
      net: current.net + day.allocatedAfterFee,
      review: current.review + (day.status === "Balanced" ? 0 : 1),
    }),
    { source: 0, net: 0, review: 0 },
  ), [data]);

  if (!session) return <main className="controlPage">Loading payroll control…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Single payroll workspace · Eastern Time</p>
        <h1>{business} payroll control</h1>
        <p>Correct shifts, recalculate hours and tips, allocate exceptions, version payroll, and lock the final run without visiting a duplicate dashboard.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills">{(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => { setBusiness(name); setEditing(null); setCorrectionReason(DEFAULT_PUNCH_CORRECTION_REASON); }}>{name}</button>)}</div>
        <label>Payroll week<input type="date" value={weekStart} onChange={(event) => { setWeekStart(event.target.value); setEditing(null); }} /></label>
        <button className="primary" onClick={() => void recalculate()} disabled={busy}>Recalculate payroll & tips</button>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <div className="controlGrid">
      <section className="controlCard">
        <div className="metricGrid">
          <div className="metric"><span>Total hours</span><strong>{hours(totals.hours)}</strong></div>
          <div className="metric"><span>Overtime</span><strong>{hours(totals.overtime)}</strong></div>
          {business === "Corner Deli" && <div className="metric"><span>Source tips before fee</span><strong>{dollars(dailyTotals.source)}</strong></div>}
          <div className="metric"><span>Net tips paid</span><strong>{dollars(totals.tips)}</strong></div>
          <div className="metric"><span>{business === "Corner Deli" ? "Days needing review" : "Unmatched tips"}</span><strong>{business === "Corner Deli" ? dailyTotals.review : data?.summary.unmatchedTips.length || 0}</strong></div>
        </div>
        <p className="reportNote">{business === "Corner Deli"
          ? "Every saved shift correction and tip override is included the next time totals load. Corner Deli tips are reconciled by business day before the 3.5% deduction, so rounding cannot quietly create extra payroll."
          : "Square tips are split equally among tip-eligible At the Docks employees clocked in when the payment was created. The tip's share of Square's recorded processing fee is deducted, up to 3.5%. Shift corrections on this page also reconcile the live employee clock state."}</p>
        {business === "Tiki" && Boolean(data?.summary.processingFeeReviewCount) && <p className="reportNote"><strong>Review processing fees:</strong> {data?.summary.processingFeeReviewCount} Square payment(s) have no usable fee information. Their tips remain gross until Square's fee is available.</p>}
      </section>

      {business === "Corner Deli" && <section className="controlCard">
        <p className="eyebrow">Daily tip control</p>
        <h2>Source tips versus payroll allocation</h2>
        <p className="reportNote">Each day must balance from the Rezku gross tip total through delivery and pickup allocation to the exact net pool after the 3.5% deduction. Manual overrides are shown separately and are not hidden inside this check.</p>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Day</th><th>Source gross</th><th>Delivery gross</th><th>Pickup gross</th><th>Unallocated gross</th><th>3.5% fee</th><th>Expected net</th><th>Allocated net</th><th>Balance</th><th>Status</th></tr></thead>
          <tbody>{data?.summary.dailyTipReconciliation?.map((day) => <tr key={day.date}>
            <td><strong>{payrollDayLabel(day.date)}</strong></td>
            <td>{dollars(day.sourceTipsBeforeFee)}</td>
            <td>{dollars(day.deliveryTipsBeforeFee)}</td>
            <td>{dollars(day.pickupTipsBeforeFee)}</td>
            <td>{dollars(day.unallocatedTipsBeforeFee + day.unclassifiedTipsBeforeFee)}</td>
            <td>{dollars(day.feeAmount)}</td>
            <td>{dollars(day.expectedAfterFee)}</td>
            <td>{dollars(day.allocatedAfterFee)}</td>
            <td>{dollars(day.balance)}</td>
            <td><span className={`badge ${day.status === "Balanced" ? "good" : "warn"}`}>{day.status}</span></td>
          </tr>)}</tbody>
        </table></div>
      </section>}

      <section className="controlCard">
        <div className="controlActions">
          <button className="primary" onClick={() => void post({ action: "draft-create", business, weekStart }).then((result) => setNotice(`Payroll draft version ${result.version} created from the current corrected totals.`))} disabled={busy || (business === "Tiki" && Boolean(data?.summary.processingFeeReviewCount))}>Create payroll draft</button>
        </div>
        <p className="eyebrow">Calculated summary</p>
        <h2>{data?.summary.source}</h2>
        {business === "Corner Deli" && <p className="reportNote">Before 3 PM, tips are split equally among all tip-eligible employees clocked in. After 3 PM, delivery tips go to the driver and takeout tips are split equally among clocked-in non-driver positions.</p>}
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Employee</th><th>Regular Hours</th><th>Tipped Hours</th><th>Tips</th>{showOvertime && <th>OT</th>}<th>Scheduled vs worked</th></tr></thead>
          <tbody>{displayRows.map((row) => <tr key={row.employee}>
            <td><strong>{row.employee}</strong></td>
            <td>{hours(row.regularHours)}</td>
            <td>{hours(row.tippedHours)}</td>
            <td><strong>{dollars(row.tips)}</strong></td>
            {showOvertime && <td>{hours(row.overtimeHours)}</td>}
            <td>{row.schedule ? <>{row.schedule.flagged && <span className="badge warn">Check</span>} {row.schedule.text}</> : "—"}</td>
          </tr>)}</tbody>
          {displayRows.length > 0 && <tfoot><tr>
            <td><strong>Totals</strong></td>
            <td>{hours(displayRows.reduce((sum, row) => sum + row.regularHours, 0))}</td>
            <td>{hours(displayRows.reduce((sum, row) => sum + row.tippedHours, 0))}</td>
            <td><strong>{dollars(displayRows.reduce((sum, row) => sum + row.tips, 0))}</strong></td>
            {showOvertime && <td>{hours(displayRows.reduce((sum, row) => sum + row.overtimeHours, 0))}</td>}
            <td>{displayRows.filter((row) => row.schedule?.flagged).length ? `${displayRows.filter((row) => row.schedule?.flagged).length} to check` : ""}</td>
          </tr></tfoot>}
        </table></div>
        <p className="reportNote">Tips include manual tip assignments. Scheduled = published shifts this payroll week (Monday 4 AM to Monday 4 AM); worked = clocked hours; the difference is worked − scheduled. Check: off by an hour or more, or a scheduled shift with no punch.</p>
      </section>

      <section className="controlCard">
        <p className="eyebrow">Shift corrections · Eastern Time</p>
        <h2>Punches used for this payroll week</h2>
        <p>{business === "Tiki" ? "Correct Tiki punches here. Save updates payroll and the live employee clock state. If a lunch IN was actually the prior OUT, use the button beside that punch." : "Every displayed and entered time is interpreted as America/New_York. The corrected times are then used for payroll and tip allocation."}</p>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Employee</th><th>Clock in</th><th>Clock out</th><th>Source</th><th>Status</th><th></th></tr></thead>
          <tbody>{data?.punches.map((punch) => <tr key={punch.id}><td><strong>{punch.employeeName}</strong><small>{punch.position}</small></td><td>{easternDateTime(punch.clockIn, punch.clockInEastern)}</td><td>{punch.clockOut ? easternDateTime(punch.clockOut, punch.clockOutEastern) : "Open"}</td><td>{punch.source}</td><td><span className={`badge ${punch.status === "Complete" || punch.status === "Corrected" ? "good" : "warn"}`}>{punch.status}</span></td><td><div className="controlActions"><button onClick={() => setEditing(punch)} disabled={busy}>Correct shift</button>{business === "Tiki" && <button onClick={() => void tikiUseAsPriorOut(punch)} disabled={busy || !punch.clockIn}>This IN was prior OUT</button>}</div></td></tr>)}</tbody>
        </table></div>
      </section>

      {editing && <section className="controlCard modalish">
        <p className="eyebrow">Shift correction · Eastern Time</p>
        <h2>{editing.employeeName}</h2>
        <form key={editing.id} className="controlForm" onSubmit={correct}>
          <label>Employee<input name="employeeName" defaultValue={editing.employeeName} /></label>
          <label>Position<input name="position" defaultValue={editing.position} /></label>
          <label>Clock in (ET)<input name="clockIn" type="datetime-local" defaultValue={easternInputValue(editing.clockIn)} required /></label>
          <label>Clock out (ET)<input name="clockOut" type="datetime-local" defaultValue={easternInputValue(editing.clockOut)} /></label>
          <label className="wide">Reason <small>Optional</small><textarea name="reason" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} maxLength={1000} placeholder="Leave blank for Owner time correction" /><small>No typing required. Blank notes use Owner time correction; your note is kept for the next edit on this page.</small></label>
          <div className="controlActions wide"><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save & recalculate"}</button><button type="button" onClick={() => setEditing(null)} disabled={busy}>Cancel</button></div>
        </form>
      </section>}

      <section className="controlCard half">
        <p className="eyebrow">Exceptions</p>
        <h2>Unmatched tips</h2>
        <div className="list">{data?.summary.unmatchedTips.map((tip) => {
          const item = tip as Record<string, unknown>;
          return <div className="listItem" key={String(item.id)}><div><strong>{dollars(Number(item.tip || 0))} · {String(item.source || "")}</strong><span>{String(item.orderId || item.transactionId || "")} · {easternDateTime(String(item.time))}</span></div><button onClick={() => { const form = document.querySelector<HTMLFormElement>("#tipOverrideForm"); if (form) { (form.elements.namedItem("sourceTransactionId") as HTMLInputElement).value = String(item.transactionId || ""); (form.elements.namedItem("amount") as HTMLInputElement).value = String(item.tip || 0); } }}>Assign</button></div>;
        })}{!data?.summary.unmatchedTips.length && <div className="emptyState">No unmatched tips for this week.</div>}</div>
      </section>

      <section className="controlCard half">
        <p className="eyebrow">Manual allocation</p>
        <h2>Add tip override</h2>
        <form id="tipOverrideForm" className="controlForm" onSubmit={tipOverride}>
          <label>Source transaction<input name="sourceTransactionId" /></label>
          <label>Employee<select name="employeeName" required><option value="">Choose employee</option>{data?.summary.rows.map((row) => <option key={row.employee}>{row.employee}</option>)}</select></label>
          <label>Amount<input name="amount" type="number" step="0.01" required /></label>
          <label>Reason<input name="reason" minLength={3} placeholder="Why this tip belongs to this employee" required /><small>Required for the payroll audit.</small></label>
          <button className="primary" disabled={busy}>Apply & recalculate</button>
        </form>
        <div className="list">{data?.summary.overrides.map((override) => {
          const item = override as Record<string, unknown>;
          return <div className="listItem" key={String(item.id)}><div><strong>{String(item.employeeName)} · {dollars(Number(item.amount || 0))}</strong><span>{String(item.reason || "")}</span></div><button onClick={() => void post({ action: "tip-override-delete", business, id: item.id }).then(() => setNotice("Tip override removed and totals recalculated."))}>Remove</button></div>;
        })}</div>
      </section>

      {data?.approval && <section className="controlCard">
        <p className="eyebrow">Approval</p>
        <h2>{data.approval.blockers.message ? "Not ready to approve" : "Ready to approve"}</h2>
        {data.approval.blockers.message
          ? <p className="reportNote"><span className="badge warn">Blocked</span> {data.approval.blockers.message}</p>
          : <p className="reportNote">No open punches or missed clock-outs this week. {data.approval.sendsToPayrollRelief
            ? "Approving a draft locks it; the store server then enters the hours and tips in Payroll Relief and saves them (it never submits). You review and press Submit there."
            : "Approving a draft locks it. The Docks isn't sent to AccountantsOffice automatically."}</p>}
        {Boolean(data.approval.blockers.needsReview) && <p className="reportNote">{data.approval.blockers.needsReview} punch(es) this week are marked Needs Review.</p>}
        {data.approval.clockOutCases.length > 0 && <div className="list">{data.approval.clockOutCases.map((item) => <div className="listItem" key={item.id}>
          <div><strong>{item.employeeName} · {item.status === "Submitted" ? `says they left ${item.employeeLeftAtEastern}` : item.status === "Resolved" ? `clocked out ${item.resolvedClockOutEastern || ""}` : "still clocked in"}</strong><span>In {item.clockInEastern} · scheduled end {item.scheduledEndEastern || "none"} · {item.smsLabel}</span></div>
          {item.status === "Resolved" ? <span className="badge good">Settled</span> : <a href={`/ops/payroll-control/clock-outs?case=${encodeURIComponent(item.id)}`}>Choose clock-out</a>}
        </div>)}</div>}
      </section>}

      <section className="controlCard">
        <p className="eyebrow">Append-only payroll history</p>
        <h2>Versions</h2>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Week</th><th>Version</th><th>Status</th><th>Generated</th><th>Locked</th><th>Actions</th></tr></thead>
          <tbody>{data?.versions.map((version) => <tr key={version.id}><td>{version.weekStart}</td><td>v{version.version}</td><td><span className={`badge ${version.status === "Locked" ? "good" : "warn"}`}>{version.status}</span></td><td>{version.generatedBy}<small>{easternDateTime(version.generatedAt)}</small></td><td>{version.lockedBy || "—"}</td><td><a href={`/api/payroll-control?export=${version.id}`}>CSV</a> {version.status === "Draft" ? <button disabled={busy || (String(version.weekStart).slice(0, 10) === weekStart && Boolean(data?.approval?.blockers.message))} title={String(version.weekStart).slice(0, 10) === weekStart ? data?.approval?.blockers.message || "" : ""} onClick={() => void post({ action: "run-lock", business, id: version.id }).then((result) => setNotice(result?.submission ? `Payroll v${version.version} approved and locked. The store server will enter it in Payroll Relief (saved, not submitted) within a few minutes.` : `Payroll v${version.version} approved and locked. ${result?.submissionNote || ""}`)).catch(() => undefined)}>Approve & lock</button> : <button onClick={() => void post({ action: "run-reopen", business, id: version.id }).then((result) => setNotice(`Reopened as payroll draft v${result.version}.`))}>Reopen as new version</button>}{(() => {
            const submission = data?.approval?.submissions.find((item) => item.payrollRunVersionId === version.id);
            if (!submission) return null;
            return <small>{submission.statusLine} {submissionControls(submission)}</small>;
          })()}</td></tr>)}</tbody>
        </table></div>
      </section>

      {relief && <section className="controlCard">
        <p className="eyebrow">AccountantsOffice employees</p>
        <h2>Who is who in Payroll Relief</h2>
        <p className="reportNote">Hours and tips are entered for the Payroll Relief employee chosen here. Guesses are pre-selected (marked Guess); check them and press Save. Anyone with hours or tips but no match stops the entry with a message, so nothing is entered for the wrong person.</p>
        {!relief.roster.length && <p className="reportNote"><span className="badge warn">No list yet</span> Payroll Relief&apos;s employee list fills in after the first send attempt, or press Check AccountantsOffice.</p>}
        <div className="controlActions">
          <button disabled={busy || Boolean(relief.rosterCheck && ["queued", "submitting", "needs_code"].includes(relief.rosterCheck.status))} onClick={() => void post({ action: "payroll-relief-check", business }).then(() => setNotice("The store server will check AccountantsOffice within a few minutes.")).catch(() => undefined)}>Check AccountantsOffice</button>
          {relief.rosterCheck && <small>{relief.rosterCheck.statusLine} {submissionControls(relief.rosterCheck)}</small>}
        </div>
        {relief.roster.length > 0 && <>
          <div className="tableWrap"><table className="controlTable">
            <thead><tr><th>Corner Ops</th><th>Payroll Relief employee</th><th></th></tr></thead>
            <tbody>{relief.people.map((person) => {
              const value = matches[person.employee] ?? "";
              const guessed = !person.eeNum && Boolean(person.guessNum) && value === person.guessNum;
              return <tr key={person.employee}>
                <td><strong>{person.employee}</strong><small>{[person.inPayroll ? "in recent payroll" : "", person.active ? "active" : "inactive"].filter(Boolean).join(" · ")}</small></td>
                <td><select value={value} onChange={(event) => setMatches((current) => ({ ...current, [person.employee]: event.target.value }))}>
                  <option value="">Not in Payroll Relief</option>
                  {relief.roster.map((entry) => <option key={entry.num} value={entry.num}>{entry.display} (#{entry.num}{entry.payType ? `, ${entry.payType === "S" ? "salaried" : "hourly"}` : ""})</option>)}
                </select></td>
                <td>{person.eeNum ? (value === person.eeNum ? <span className="badge good">Saved</span> : <span className="badge warn">Changed</span>) : guessed ? <span className="badge warn" title={person.guessReason}>Guess: {person.guessReason}</span> : value ? <span className="badge warn">Not saved</span> : ""}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <div className="controlActions"><button className="primary" disabled={busy} onClick={() => void post({ action: "payroll-relief-map-save", business, mappings: relief.people.map((person) => ({ employee: person.employee, eeNum: matches[person.employee] ?? "" })) }).then(() => setNotice("Payroll Relief employees saved.")).catch(() => undefined)}>Save matches</button></div>
          <p className="reportNote">Payroll Relief list last seen {relief.roster.reduce((latest, entry) => entry.lastSeenAt && entry.lastSeenAt > latest ? entry.lastSeenAt : latest, "") ? easternDateTime(relief.roster.reduce((latest, entry) => entry.lastSeenAt && entry.lastSeenAt > latest ? entry.lastSeenAt : latest, "")) : "—"}.</p>
        </>}
      </section>}

      <section className="controlCard half">
        <p className="eyebrow">Shift changes</p>
        <h2>Correction audit</h2>
        <div className="list">{data?.adjustments.slice(0, 15).map((adjustment) => {
          const item = adjustment as Record<string, unknown>;
          return <div className="listItem" key={String(item.id)}><div><strong>{String(item.sourceType)} shift corrected</strong><span>{String(item.reason)} · {String(item.actor)}</span></div><small>{easternDateTime(String(item.createdAt))}</small></div>;
        })}</div>
      </section>

      <section className="controlCard half">
        <p className="eyebrow">Payroll actions</p>
        <h2>Audit events</h2>
        <div className="list">{data?.auditEvents.slice(0, 15).map((event) => {
          const item = event as Record<string, unknown>;
          return <div className="listItem" key={String(item.id)}><div><strong>{String(item.eventType)}</strong><span>{String(item.actor)}</span></div><small>{easternDateTime(String(item.createdAt))}</small></div>;
        })}</div>
      </section>
    </div>
  </main>;
}

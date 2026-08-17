"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
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

type Dashboard = {
  summary: {
    source: string;
    weekStart: string;
    weekEnd: string;
    rows: PayrollRow[];
    overrides: Array<Record<string, unknown>>;
    unmatchedTips: Array<Record<string, unknown>>;
    dailyTipReconciliation?: DailyTipCheck[];
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

function easternOffsetMilliseconds(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  ) - date.getTime();
}

function easternInputToIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Enter a valid Eastern date and time.");
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0);
  let timestamp = wall;
  for (let index = 0; index < 3; index += 1) timestamp = wall - easternOffsetMilliseconds(new Date(timestamp));
  return new Date(timestamp).toISOString();
}

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function PayrollControlPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [weekStart, setWeekStart] = useState(previousMonday());
  const [data, setData] = useState<Dashboard | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Punch | null>(null);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setNotice("Unable to load the current account."));
  }, []);

  async function load(activeBusiness = business, activeWeek = weekStart) {
    const response = await fetch(
      `/api/payroll-control?business=${encodeURIComponent(activeBusiness)}&weekStart=${encodeURIComponent(activeWeek)}&displayVersion=20260804-3`,
      { cache: "no-store", headers: { "Cache-Control": "no-cache" } },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
    setData(await response.json() as Dashboard);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    void load(business, weekStart).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business, weekStart]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/payroll-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
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
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const clockIn = String(form.get("clockIn") || "");
    const clockOut = String(form.get("clockOut") || "");
    await post({
      action: "punch-correct",
      business,
      sourceType: business === "Tiki" ? "Tiki" : "Rezku",
      sourceId: editing.id,
      employeeName: form.get("employeeName"),
      position: form.get("position"),
      clockIn: easternInputToIso(clockIn),
      clockOut: clockOut ? easternInputToIso(clockOut) : null,
      reason: form.get("reason"),
    });
    setEditing(null);
    setNotice("Shift corrected in Eastern Time. Payroll hours and tip allocation were recalculated immediately.");
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
        <div className="businessPills">{(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => { setBusiness(name); setEditing(null); }}>{name}</button>)}</div>
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
          : "Square tips are split equally among tip-eligible Tiki employees clocked in when the payment was created. Payments without a matching punch stay below for review."}</p>
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
          <button className="primary" onClick={() => void post({ action: "draft-create", business, weekStart }).then((result) => setNotice(`Payroll draft version ${result.version} created from the current corrected totals.`))} disabled={busy}>Create payroll draft</button>
        </div>
        <p className="eyebrow">Calculated summary</p>
        <h2>{data?.summary.source}</h2>
        {business === "Corner Deli" && <p className="reportNote">Before 3 PM, tips are split equally among all tip-eligible employees clocked in. After 3 PM, delivery tips go to the driver and takeout tips are split equally among clocked-in non-driver positions.</p>}
        <div className="tableWrap"><table className="controlTable">
          {business === "Corner Deli" ? <>
            <thead><tr><th>Employee</th><th>Total</th><th>Regular</th><th>OT</th><th>Driver tipped</th><th>Pickup gross</th><th>Delivery gross</th><th>Gross tips</th><th>3.5% fee</th><th>Manual</th><th>Net paid</th></tr></thead>
            <tbody>{data?.summary.rows.map((row) => {
              const manual = row.manualTips || 0;
              const gross = row.tipsBeforeFee || 0;
              const automaticNet = row.tips - manual;
              return <tr key={row.employee}><td><strong>{row.employee}</strong></td><td>{hours(row.hours)}</td><td>{hours(row.regularHours)}</td><td>{hours(row.overtimeHours)}</td><td>{hours(row.driverTipHours)}</td><td>{dollars(row.pickupTipsBeforeFee || 0)}</td><td>{dollars(row.deliveryTipsBeforeFee || 0)}</td><td><strong>{dollars(gross)}</strong></td><td>{dollars(gross - automaticNet)}</td><td>{dollars(manual)}</td><td><strong>{dollars(row.tips)}</strong></td></tr>;
            })}</tbody>
          </> : <>
            <thead><tr><th>Employee</th><th>Total</th><th>Regular</th><th>OT</th><th>Tipped hours</th><th>Automatic tips</th><th>Manual</th><th>Total tips</th></tr></thead>
            <tbody>{data?.summary.rows.map((row) => <tr key={row.employee}><td><strong>{row.employee}</strong></td><td>{hours(row.hours)}</td><td>{hours(row.regularHours)}</td><td>{hours(row.overtimeHours)}</td><td>{hours(row.driverTipHours)}</td><td>{dollars(row.tips - (row.manualTips || 0))}</td><td>{dollars(row.manualTips || 0)}</td><td><strong>{dollars(row.tips)}</strong></td></tr>)}</tbody>
          </>}
        </table></div>
      </section>

      <section className="controlCard">
        <p className="eyebrow">Shift corrections · Eastern Time</p>
        <h2>Punches used for this payroll week</h2>
        <p>Every displayed and entered time is interpreted as America/New_York. The corrected times are then used for payroll and tip allocation.</p>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Employee</th><th>Clock in</th><th>Clock out</th><th>Source</th><th>Status</th><th></th></tr></thead>
          <tbody>{data?.punches.map((punch) => <tr key={punch.id}><td><strong>{punch.employeeName}</strong><small>{punch.position}</small></td><td>{easternDateTime(punch.clockIn, punch.clockInEastern)}</td><td>{punch.clockOut ? easternDateTime(punch.clockOut, punch.clockOutEastern) : "Open"}</td><td>{punch.source}</td><td><span className={`badge ${punch.status === "Complete" ? "good" : "warn"}`}>{punch.status}</span></td><td><button onClick={() => setEditing(punch)}>Correct shift</button></td></tr>)}</tbody>
        </table></div>
      </section>

      {editing && <section className="controlCard modalish">
        <p className="eyebrow">Shift correction · Eastern Time</p>
        <h2>{editing.employeeName}</h2>
        <form className="controlForm" onSubmit={correct}>
          <label>Employee<input name="employeeName" defaultValue={editing.employeeName} /></label>
          <label>Position<input name="position" defaultValue={editing.position} /></label>
          <label>Clock in (ET)<input name="clockIn" type="datetime-local" defaultValue={easternInputValue(editing.clockIn)} required /></label>
          <label>Clock out (ET)<input name="clockOut" type="datetime-local" defaultValue={easternInputValue(editing.clockOut)} /></label>
          <label className="wide">Reason<textarea name="reason" required /></label>
          <div className="controlActions wide"><button className="primary" disabled={busy}>Save & recalculate</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
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

      <section className="controlCard">
        <p className="eyebrow">Append-only payroll history</p>
        <h2>Versions</h2>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Week</th><th>Version</th><th>Status</th><th>Generated</th><th>Locked</th><th>Actions</th></tr></thead>
          <tbody>{data?.versions.map((version) => <tr key={version.id}><td>{version.weekStart}</td><td>v{version.version}</td><td><span className={`badge ${version.status === "Locked" ? "good" : "warn"}`}>{version.status}</span></td><td>{version.generatedBy}<small>{easternDateTime(version.generatedAt)}</small></td><td>{version.lockedBy || "—"}</td><td><a href={`/api/payroll-control?export=${version.id}`}>CSV</a> {version.status === "Draft" ? <button onClick={() => void post({ action: "run-lock", business, id: version.id }).then(() => setNotice(`Payroll v${version.version} locked.`))}>Lock</button> : <button onClick={() => void post({ action: "run-reopen", business, id: version.id }).then((result) => setNotice(`Reopened as payroll draft v${result.version}.`))}>Reopen as new version</button>}</td></tr>)}</tbody>
        </table></div>
      </section>

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

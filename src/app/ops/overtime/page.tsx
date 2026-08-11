"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "./overtime.css";

type ScheduledShift = {
  id: string;
  employeeId: string | null;
  employeeName: string;
  position: string;
  startsAt: string;
  endsAt: string;
  paidHours: number;
};

type Replacement = {
  employeeId: string;
  employeeName: string;
  position: string;
  projectedHours: number;
  projectedAfterShift: number;
  availability: "Available" | "Not set";
  reason: string;
};

type RiskItem = {
  employeeId: string;
  employeeName: string;
  position: string;
  risk: "normal" | "warning" | "overtime";
  actualHours: number;
  expectedHoursToDate: number;
  paceDeltaHours: number;
  paceStatus: "ahead" | "behind" | "on-pace";
  remainingScheduledHours: number;
  projectedHours: number;
  plannedHours: number;
  unplannedHours: number;
  warningShift: ScheduledShift | null;
  overtimeShift: ScheduledShift | null;
  replacementShift: ScheduledShift | null;
  replacements: Replacement[];
};

type CoverageMismatch = {
  actualEntryId: string;
  actualEmployeeName: string;
  scheduledEmployeeName: string;
  startsAt: string | null;
  endsAt: string | null;
  hours: number;
  kind: string;
  detail: string;
};

type ShiftChange = {
  id: string;
  changeType: string;
  priorEmployeeName: string;
  newEmployeeName: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  details: Record<string, unknown>;
};

type Dashboard = {
  business: Business;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  paceAsOf?: string;
  suppressedMinorTimingDifferences?: number;
  thresholds: { warning: number; overtime: number; projectionAlertWeekProgress?: number };
  summary: { activeEmployees: number; warning: number; overtime: number; coverageMismatches: number };
  risks: RiskItem[];
  coverageMismatches: CoverageMismatch[];
  shiftChanges: ShiftChange[];
  notified?: Array<{ employeeId: string; delivered: number; failed: number }>;
};

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function local(value: string | null | undefined) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shiftLabel(shift: ScheduledShift | null) {
  if (!shift) return "No remaining shift identified";
  return `${local(shift.startsAt)}–${new Date(shift.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${shift.position || "Shift"}`;
}

function hours(value: number) {
  return Number(value || 0).toFixed(1);
}

function paceText(risk: RiskItem) {
  if (risk.paceStatus === "ahead") return `${hours(Math.abs(risk.paceDeltaHours))}h ahead of schedule`;
  if (risk.paceStatus === "behind") return `${hours(Math.abs(risk.paceDeltaHours))}h behind schedule`;
  return "On scheduled pace";
}

export default function OvertimeRiskPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("business");
    if (query === "Corner Deli" || query === "Tiki") setBusiness(query);
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach server"] }));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    const url = new URL(window.location.href);
    url.searchParams.set("business", business);
    window.history.replaceState(null, "", url);
  }, [business]);

  const load = useCallback(async (activeBusiness: Business, sendAlerts = false) => {
    setBusy(true);
    setNotice("");
    try {
      const response = sendAlerts
        ? await fetch("/api/overtime-risk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "run-check", business: activeBusiness }),
          })
        : await fetch(`/api/overtime-risk?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as Dashboard;
      setData(payload);
      if (sendAlerts) {
        const delivered = (payload.notified || []).reduce((total, item) => total + item.delivered, 0);
        setNotice(delivered
          ? `Overtime check completed and ${delivered} owner notification${delivered === 1 ? " was" : "s were"} delivered.`
          : "Overtime check completed. No new owner alert was required.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to load overtime risk.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    void load(business);
  }, [business, load, session?.authenticated]);

  const currentData = data?.business === business ? data : null;
  const activeRisks = useMemo(
    () => (currentData?.risks || []).filter((item) => item.risk !== "normal"),
    [currentData?.risks],
  );

  if (!session) return <main className="overtimeShell"><section className="overtimePanel"><h1>Loading overtime monitor</h1></section></main>;
  if (!session.authenticated) return <main className="overtimeShell"><section className="overtimePanel"><h1>Owner access required</h1><a className="otPrimary" href="/">Return to sign-in</a></section></main>;

  return <main className="overtimeShell">
    <header className="overtimeHero">
      <div>
        <p className="otEyebrow">Daily pace + weekly projection</p>
        <h1>Overtime & Shift Coverage</h1>
        <p>Compares hours actually worked with where each employee should be by this point in the week. Full-week projections remain visible for planning, but projected-hour warnings wait until about 75% of the week has elapsed unless actual worked hours already reach the warning threshold.</p>
      </div>
      <div className="otBusinessSwitch">
        {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}
      </div>
    </header>

    <div className="overtimeActions">
      <div>
        <strong>{currentData ? `${currentData.weekStart} through ${currentData.weekEnd}` : "Current Monday–Sunday week"}</strong>
        <span>{currentData ? `Pace measured through ${local(currentData.paceAsOf || currentData.generatedAt)} · projected warnings begin about 75% through the week` : "Actual warning at 38 hours · projected warnings begin about 75% through the week"}</span>
      </div>
      <button className="otPrimary" disabled={busy} onClick={() => void load(business, true)}>{busy ? "Checking…" : "Run check & alert"}</button>
    </div>

    {notice && <div className="otNotice">{notice}</div>}

    <section className="overtimeStats">
      <article><span>Employees checked</span><strong>{currentData?.summary.activeEmployees || 0}</strong></article>
      <article><span>Near 40 hours</span><strong>{currentData?.summary.warning || 0}</strong></article>
      <article className="danger"><span>Projected overtime</span><strong>{currentData?.summary.overtime || 0}</strong></article>
      <article><span>True coverage differences</span><strong>{currentData?.summary.coverageMismatches || 0}</strong><small>{currentData?.suppressedMinorTimingDifferences ? `${currentData.suppressedMinorTimingDifferences} minor same-day timing difference${currentData.suppressedMinorTimingDifferences === 1 ? "" : "s"} ignored` : "Late arrivals and early/late departures are matched to the employee's own shift"}</small></article>
    </section>

    <section className="overtimeSection">
      <div className="otSectionHeader"><div><p className="otEyebrow">Action needed</p><h2>Employees at risk</h2></div><span>{activeRisks.length} flagged</span></div>
      <div className="overtimeRiskList">
        {activeRisks.map((risk) => <article className={`overtimeRiskCard ${risk.risk}`} key={risk.employeeId}>
          <header>
            <div><h3>{risk.employeeName}</h3><span>{risk.position}</span></div>
            <strong>{risk.risk === "overtime" ? "OVERTIME" : "CLOSE"}</strong>
          </header>
          <div className="paceSummary">
            <div><span>Should have by now</span><b>{hours(risk.expectedHoursToDate)}h</b></div>
            <div><span>Actually worked</span><b>{hours(risk.actualHours)}h</b></div>
            <strong className={`paceBadge ${risk.paceStatus}`}>{paceText(risk)}</strong>
          </div>
          <div className="riskEquation">
            <div><span>Worked</span><b>{hours(risk.actualHours)}h</b></div>
            <i>+</i>
            <div><span>Remaining</span><b>{hours(risk.remainingScheduledHours)}h</b></div>
            <i>=</i>
            <div><span>Projected</span><b>{hours(risk.projectedHours)}h</b></div>
          </div>
          {risk.unplannedHours > 0 && <p className="unplannedCallout"><strong>{hours(risk.unplannedHours)} unplanned hours</strong> remain after matching minor same-day punch differences to the employee's own schedule.</p>}
          <div className="triggerShift">
            <span>{risk.risk === "overtime" ? "First shift creating overtime" : "First shift reaching the warning range"}</span>
            <strong>{shiftLabel(risk.risk === "overtime" ? risk.overtimeShift : risk.warningShift)}</strong>
          </div>
          <div className="replacementBlock">
            <h4>Suggested replacements</h4>
            {risk.replacements.map((replacement, index) => <div className="replacementRow" key={replacement.employeeId}>
              <span className="replacementRank">{index + 1}</span>
              <div><strong>{replacement.employeeName}</strong><span>{replacement.position} · {replacement.availability}</span><small>{replacement.reason}</small></div>
              <b>{hours(replacement.projectedAfterShift)}h</b>
            </div>)}
            {!risk.replacements.length && <p>No conflict-free replacement stays at or below 40 hours. The shift may need to be shortened, split, or filled outside the active roster.</p>}
          </div>
        </article>)}
        {!activeRisks.length && <article className="overtimeClear"><strong>No current overtime risk</strong><span>Actual worked hours plus remaining assigned shifts keep every active employee below 38 hours.</span></article>}
      </div>
    </section>

    <section className="overtimeSection">
      <div className="otSectionHeader"><div><p className="otEyebrow">Entire roster</p><h2>Daily pace and weekly projection</h2></div><span>Calculated separately by business</span></div>
      <div className="otTableWrap"><table className="otTable paceTable"><thead><tr><th>Employee</th><th>Should have by now</th><th>Worked</th><th>Pace</th><th>Remaining</th><th>Projected</th><th>Status</th></tr></thead><tbody>
        {(currentData?.risks || []).map((risk) => <tr key={risk.employeeId}>
          <td><strong>{risk.employeeName}</strong><span>{risk.position}</span></td>
          <td>{hours(risk.expectedHoursToDate)}</td>
          <td>{hours(risk.actualHours)}</td>
          <td><span className={`paceBadge ${risk.paceStatus}`}>{paceText(risk)}</span></td>
          <td>{hours(risk.remainingScheduledHours)}</td>
          <td><strong>{hours(risk.projectedHours)}</strong></td>
          <td><span className={`otStatus ${risk.risk}`}>{risk.risk === "normal" ? "OK" : risk.risk === "warning" ? "Close" : "Overtime"}</span></td>
        </tr>)}
      </tbody></table></div>
    </section>

    <section className="overtimeTwoColumn">
      <article className="overtimePanel">
        <div className="otSectionHeader"><div><p className="otEyebrow">Actual versus assigned</p><h2>Coverage differences</h2></div></div>
        <div className="otActivityList">
          {(currentData?.coverageMismatches || []).map((item) => <div key={item.actualEntryId}><header><strong>{item.actualEmployeeName}</strong><span>{item.kind}</span></header><p>{item.detail}</p><small>{local(item.startsAt)} · {hours(item.hours)} hours</small></div>)}
          {!currentData?.coverageMismatches.length && <p className="otEmpty">No genuine unscheduled or substituted work detected this week. Minor late arrivals and early or late departures are ignored here.</p>}
        </div>
      </article>

      <article className="overtimePanel">
        <div className="otSectionHeader"><div><p className="otEyebrow">Schedule audit</p><h2>Recent shift changes</h2></div></div>
        <div className="otActivityList">
          {(currentData?.shiftChanges || []).map((change) => <div key={change.id}><header><strong>{change.changeType}</strong><span>{local(change.createdAt)}</span></header><p>{change.priorEmployeeName && change.newEmployeeName ? `${change.priorEmployeeName} → ${change.newEmployeeName}` : change.newEmployeeName || change.priorEmployeeName || String(change.details.position || "Shift")}</p><small>{local(change.startsAt)}</small></div>)}
          {!currentData?.shiftChanges.length && <p className="otEmpty">No recorded shift changes this week.</p>}
        </div>
      </article>
    </section>

    {currentData && <p className="overtimeGenerated">Updated {local(currentData.generatedAt)}. Corner Deli and Tiki hours are intentionally calculated separately.</p>}
  </main>;
}

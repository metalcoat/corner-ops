"use client";

import { useCallback, useEffect, useState } from "react";
import type { Business } from "@/lib/types";
import "./payroll-cost-banner.css";

type Estimate = {
  business: Business;
  weekStart: string;
  weekEnd: string;
  shiftCount: number;
  assignedShiftCount: number;
  openShiftCount: number;
  employeeCount: number;
  paidHours: number;
  regularHours: number;
  overtimeHours: number;
  deliveryHours: number;
  grossWages: number;
  deliveryWages: number;
  missingRateHours: number;
  includesEmployerTaxes: boolean;
  note: string;
};

function monday(value: Date): Date {
  const date = new Date(value);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function dateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateLabel(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error || `Request failed (${response.status}).`;
}

export default function PayrollCostBanner() {
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [weekStart, setWeekStart] = useState(() => monday(new Date()));
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/workforce/payroll-estimate?business=${encodeURIComponent(business)}&weekStart=${dateKey(weekStart)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response));
      setEstimate(await response.json() as Estimate);
    } catch (error) {
      setEstimate(null);
      setNotice(error instanceof Error ? error.message : "Payroll estimate could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [business, weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  return <section className="payrollEstimateBanner" aria-label="Scheduled payroll estimate">
    <header>
      <div>
        <p>Scheduled payroll forecast</p>
        <h2>{business} · {dateLabel(dateKey(weekStart))}–{dateLabel(dateKey(addDays(weekStart, 6)))}</h2>
        <span>Gross scheduled wages before employer taxes, tips, reimbursements, and payroll fees.</span>
      </div>
      <div className="payrollEstimateControls">
        <div className="payrollEstimateBusiness">
          {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button type="button" key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}
        </div>
        <button type="button" onClick={() => setWeekStart((value) => addDays(value, -7))}>← Prior week</button>
        <button type="button" onClick={() => setWeekStart(monday(new Date()))}>Current week</button>
        <button type="button" onClick={() => setWeekStart((value) => addDays(value, 7))}>Next week →</button>
        <button type="button" onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
      </div>
    </header>

    {notice && <div className="payrollEstimateNotice">{notice}</div>}
    {estimate && <>
      <div className="payrollEstimateStats">
        <article><span>Potential gross payroll</span><strong>{money(estimate.grossWages)}</strong><small>{estimate.employeeCount} scheduled employees</small></article>
        <article><span>Paid hours</span><strong>{estimate.paidHours.toFixed(1)}</strong><small>{estimate.regularHours.toFixed(1)} regular · {estimate.overtimeHours.toFixed(1)} OT</small></article>
        <article><span>Delivery-rate work</span><strong>{estimate.deliveryHours.toFixed(1)} hrs</strong><small>{money(estimate.deliveryWages)} at delivery rates</small></article>
        <article><span>Schedule coverage</span><strong>{estimate.assignedShiftCount}/{estimate.shiftCount}</strong><small>{estimate.openShiftCount} open shift{estimate.openShiftCount === 1 ? "" : "s"}</small></article>
      </div>
      {(estimate.missingRateHours > 0 || estimate.openShiftCount > 0 || estimate.overtimeHours > 0) && <div className="payrollEstimateWarnings">
        {estimate.missingRateHours > 0 && <span>{estimate.missingRateHours.toFixed(1)} scheduled hours have no usable pay rate.</span>}
        {estimate.openShiftCount > 0 && <span>Open shifts are excluded until assigned to an employee.</span>}
        {estimate.overtimeHours > 0 && <span>{estimate.overtimeHours.toFixed(1)} overtime hours are priced at 1.5× the applicable normal or delivery rate.</span>}
      </div>}
    </>}
  </section>;
}

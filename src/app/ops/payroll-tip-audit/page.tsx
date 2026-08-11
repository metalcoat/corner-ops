"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionView } from "@/lib/types";
import "../control-center.css";

const TIME_ZONE = "America/New_York";

const dollars = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
}).format(Number(value || 0));

type TipDetail = {
  time?: string | null;
  orderOpenedAt?: string | null;
  transactionTime?: string | null;
  orderId?: string;
  orderType?: string;
  originalTip?: number;
  allocatedTipBeforeFee?: number;
  feeAmount?: number;
  allocatedTip?: number;
  employee?: string;
  splitCount?: number;
  rule?: string;
};

type PayrollRow = {
  employee: string;
  tips: number;
  manualTips?: number;
};

type PayrollResponse = {
  summary: {
    weekStart: string;
    weekEnd: string;
    rows: PayrollRow[];
    tipDetails?: TipDetail[];
  };
};

function previousMonday() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
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

function easternDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function easternDayKey(value: string | null | undefined) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function dayLabel(value: string) {
  if (value === "Unknown") return value;
  const parsed = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

export default function PayrollTipAuditPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [weekStart, setWeekStart] = useState(previousMonday());
  const [employee, setEmployee] = useState("All employees");
  const [deliveryOnly, setDeliveryOnly] = useState(false);
  const [data, setData] = useState<PayrollResponse | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setNotice("Unable to load the current account."));
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    fetch(`/api/payroll-control?business=${encodeURIComponent("Corner Deli")}&weekStart=${encodeURIComponent(weekStart)}&displayVersion=20260811-tip-audit`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Payroll request failed (${response.status}).`);
        return response.json();
      })
      .then((payload: PayrollResponse) => setData(payload))
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [session?.authenticated, weekStart]);

  const employees = useMemo(() => {
    const names = new Set((data?.summary.tipDetails || [])
      .map((detail) => String(detail.employee || ""))
      .filter((name) => name && name !== "Unallocated"));
    return [...names].sort();
  }, [data]);

  const details = useMemo(() => (data?.summary.tipDetails || [])
    .filter((detail) => employee === "All employees" || detail.employee === employee)
    .filter((detail) => !deliveryOnly || /deliver/i.test(String(detail.orderType || "")))
    .sort((left, right) => new Date(left.orderOpenedAt || left.time || 0).getTime() - new Date(right.orderOpenedAt || right.time || 0).getTime()),
  [data, employee, deliveryOnly]);

  const daily = useMemo(() => {
    const byDay = new Map<string, { orders: Set<string>; gross: number; net: number; deliveryNet: number }>();
    for (const detail of details) {
      const day = easternDayKey(detail.orderOpenedAt || detail.time);
      const current = byDay.get(day) || { orders: new Set<string>(), gross: 0, net: 0, deliveryNet: 0 };
      current.orders.add(`${detail.orderId || ""}|${detail.orderOpenedAt || detail.time || ""}`);
      current.gross += Number(detail.allocatedTipBeforeFee || 0);
      current.net += Number(detail.allocatedTip || 0);
      if (/deliver/i.test(String(detail.orderType || ""))) current.deliveryNet += Number(detail.allocatedTip || 0);
      byDay.set(day, current);
    }
    return [...byDay.entries()].map(([date, value]) => ({
      date,
      orderCount: value.orders.size,
      gross: value.gross,
      net: value.net,
      deliveryNet: value.deliveryNet,
    })).sort((left, right) => left.date.localeCompare(right.date));
  }, [details]);

  const selectedSummary = data?.summary.rows.find((row) => row.employee === employee);
  const automaticNet = details.reduce((total, detail) => total + Number(detail.allocatedTip || 0), 0);

  if (!session) return <main className="controlPage">Loading tip audit…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Corner Deli · payroll audit</p>
        <h1>Tip allocation detail</h1>
        <p>Every allocated tip below comes from the live Corner Ops payroll calculation. Order-open time controls the payroll day and the before/after 3 PM rule.</p>
      </div>
      <div className="controlActions">
        <a href="/ops/payroll-control">Back to payroll control</a>
        <label>Payroll week<input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} /></label>
        <label>Employee<select value={employee} onChange={(event) => setEmployee(event.target.value)}>
          <option>All employees</option>
          {employees.map((name) => <option key={name}>{name}</option>)}
        </select></label>
        <label><input type="checkbox" checked={deliveryOnly} onChange={(event) => setDeliveryOnly(event.target.checked)} /> Delivery only</label>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <div className="controlGrid">
      <section className="controlCard">
        <div className="metricGrid">
          <div className="metric"><span>Displayed automatic tips</span><strong>{dollars(automaticNet)}</strong></div>
          <div className="metric"><span>Payroll row net</span><strong>{employee === "All employees" ? "—" : dollars(selectedSummary?.tips || 0)}</strong></div>
          <div className="metric"><span>Manual adjustments</span><strong>{employee === "All employees" ? "—" : dollars(selectedSummary?.manualTips || 0)}</strong></div>
          <div className="metric"><span>Allocation rows</span><strong>{details.length}</strong></div>
        </div>
        {employee !== "All employees" && Math.abs((selectedSummary?.tips || 0) - (selectedSummary?.manualTips || 0) - automaticNet) > 0.02
          ? <p className="reportNote"><strong>Warning:</strong> the payroll summary does not equal the visible automatic allocation detail. That indicates an additional calculation problem and should not be locked.</p>
          : <p className="reportNote">The automatic detail should equal the employee payroll total minus any manual adjustment.</p>}
      </section>

      <section className="controlCard">
        <p className="eyebrow">By business day</p>
        <h2>{employee}</h2>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Day</th><th>Orders</th><th>Allocated gross</th><th>Delivery net</th><th>Total net</th></tr></thead>
          <tbody>{daily.map((day) => <tr key={day.date}>
            <td><strong>{dayLabel(day.date)}</strong></td>
            <td>{day.orderCount}</td>
            <td>{dollars(day.gross)}</td>
            <td>{dollars(day.deliveryNet)}</td>
            <td><strong>{dollars(day.net)}</strong></td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <section className="controlCard">
        <p className="eyebrow">Order-by-order allocation</p>
        <h2>What created the total</h2>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>Order opened</th><th>Employee</th><th>Order</th><th>Type</th><th>Original tip</th><th>Allocated gross</th><th>Fee</th><th>Net</th><th>Rule</th></tr></thead>
          <tbody>{details.map((detail, index) => <tr key={`${detail.orderId}-${detail.orderOpenedAt}-${detail.employee}-${index}`}>
            <td>{easternDateTime(detail.orderOpenedAt || detail.time)}</td>
            <td><strong>{detail.employee || "—"}</strong></td>
            <td>{detail.orderId || "—"}</td>
            <td>{detail.orderType || "—"}</td>
            <td>{dollars(Number(detail.originalTip || 0))}</td>
            <td>{dollars(Number(detail.allocatedTipBeforeFee || 0))}</td>
            <td>{dollars(Number(detail.feeAmount || 0))}</td>
            <td><strong>{dollars(Number(detail.allocatedTip || 0))}</strong></td>
            <td>{detail.rule || "—"}</td>
          </tr>)}</tbody>
        </table></div>
        {!details.length && <div className="emptyState">No allocations match these filters.</div>}
      </section>
    </div>
  </main>;
}

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
  rezkuOrderTimeRepair?: {
    checked?: number;
    repaired?: number;
    missingRawClock?: number;
    numericRawClock?: number;
  } | null;
  summary: {
    weekStart: string;
    weekEnd: string;
    rows: PayrollRow[];
    tipDetails?: TipDetail[];
  };
};

type RezkuEmailReceipt = {
  emailId: string;
  reportDate: string | null;
  status: string;
};

type RezkuMonitorResponse = {
  emails?: RezkuEmailReceipt[];
};

type RezkuRetryResponse = {
  processed?: boolean;
  reports?: Array<Record<string, unknown>>;
  failures?: string[];
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

function plusDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
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

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function PayrollTipAuditPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [weekStart, setWeekStart] = useState(previousMonday());
  const [employee, setEmployee] = useState("All employees");
  const [deliveryOnly, setDeliveryOnly] = useState(false);
  const [data, setData] = useState<PayrollResponse | null>(null);
  const [notice, setNotice] = useState("");
  const [repairing, setRepairing] = useState(false);

  async function loadPayroll(selectedWeek = weekStart) {
    const response = await fetch(`/api/payroll-control?business=${encodeURIComponent("Corner Deli")}&weekStart=${encodeURIComponent(selectedWeek)}&displayVersion=20260811-tip-audit-rezku-repair`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error(await responseError(response));
    setData(await response.json() as PayrollResponse);
  }

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setNotice("Unable to load the current account."));
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    void loadPayroll(weekStart).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [session?.authenticated, weekStart]);

  async function reimportRezkuWeek() {
    setRepairing(true);
    setNotice("Finding the original Rezku emails for this payroll week…");
    try {
      const monitorResponse = await fetch("/api/rezku-monitor", { cache: "no-store" });
      if (!monitorResponse.ok) throw new Error(await responseError(monitorResponse));
      const monitor = await monitorResponse.json() as RezkuMonitorResponse;
      const weekEnd = plusDays(weekStart, 7);
      const emails = (monitor.emails || [])
        .filter((email) => Boolean(email.reportDate && email.reportDate >= weekStart && email.reportDate < weekEnd))
        .sort((left, right) => String(left.reportDate).localeCompare(String(right.reportDate)));

      if (!emails.length) throw new Error("Corner Ops does not have retained Rezku inbound emails for this payroll week.");

      const failures: string[] = [];
      let completed = 0;
      for (const email of emails) {
        setNotice(`Re-importing Rezku source for ${email.reportDate || "unknown date"} (${completed + 1} of ${emails.length})…`);
        try {
          const response = await fetch("/api/rezku-monitor", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "retry-email", emailId: email.emailId }),
          });
          if (!response.ok) throw new Error(await responseError(response));
          const result = await response.json() as RezkuRetryResponse;
          if (result.failures?.length) failures.push(`${email.reportDate}: ${result.failures.join("; ")}`);
        } catch (error) {
          failures.push(`${email.reportDate}: ${error instanceof Error ? error.message : String(error)}`);
        }
        completed += 1;
      }

      setNotice("Re-import complete. Recalculating payroll from the restored Rezku order times…");
      await loadPayroll(weekStart);
      setNotice(failures.length
        ? `Re-imported ${emails.length} Rezku email${emails.length === 1 ? "" : "s"}, but some reports need review: ${failures.join(" | ")}`
        : `Re-imported ${emails.length} Rezku email${emails.length === 1 ? "" : "s"} and recalculated payroll from the restored source timestamps.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairing(false);
    }
  }

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
        <label>Payroll week<input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} disabled={repairing} /></label>
        <label>Employee<select value={employee} onChange={(event) => setEmployee(event.target.value)} disabled={repairing}>
          <option>All employees</option>
          {employees.map((name) => <option key={name}>{name}</option>)}
        </select></label>
        <label><input type="checkbox" checked={deliveryOnly} onChange={(event) => setDeliveryOnly(event.target.checked)} disabled={repairing} /> Delivery only</label>
        <button className="primary" disabled={repairing} onClick={() => void reimportRezkuWeek()}>{repairing ? "Re-importing Rezku week…" : "Re-import Rezku source week"}</button>
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
        <p className="reportNote"><strong>Rezku time repair:</strong> checked {data?.rezkuOrderTimeRepair?.checked ?? 0}, repaired {data?.rezkuOrderTimeRepair?.repaired ?? 0}, missing usable raw clock {data?.rezkuOrderTimeRepair?.missingRawClock ?? 0}, numeric raw clock {data?.rezkuOrderTimeRepair?.numericRawClock ?? 0}.</p>
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
